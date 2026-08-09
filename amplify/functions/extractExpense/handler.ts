import { Handler } from 'aws-lambda';
import { TextractClient, AnalyzeExpenseCommand } from '@aws-sdk/client-textract';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

const textract = new TextractClient({});
const bedrock = new BedrockRuntimeClient({});

// ---------------------------------------------------------
// HELPER: NATIVE GRAPHQL FETCH (Replaces Amplify Client)
// ---------------------------------------------------------
const executeGraphQL = async (query: string, variables: any) => {
  const endpoint = process.env.AMPLIFY_DATA_GRAPHQL_ENDPOINT;
  const apiKey = process.env.AMPLIFY_DATA_GRAPHQL_API_KEY;

  if (!endpoint || !apiKey) throw new Error("Missing AppSync environment variables.");

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey
    },
    body: JSON.stringify({ query, variables })
  });

  const json = await response.json();
  if (json.errors) {
    console.error("AppSync Error:", JSON.stringify(json.errors, null, 2));
    throw new Error(json.errors[0].message);
  }
  return json.data;
};

interface ExtractionPayload {
  documentType: string;
  bucket: string;
  key: string;
}

export const handler: Handler<ExtractionPayload> = async (event) => {
  console.log("ExtractExpense triggered:", JSON.stringify(event, null, 2));
  const { bucket, key } = event;

  // Extract userId and documentId from the S3 Key
  const pathParts = key.split('/');
  const userId = pathParts[0]; 
  const fileName = pathParts.pop() || '';
  const documentId = fileName.split('.')[0]; 

  try {
    // ---------------------------------------------------------
    // 1. FETCH CUSTOMER CONFIGURATION (Native GraphQL)
    // ---------------------------------------------------------
    // ---------------------------------------------------------
    // 1. FETCH CUSTOMER CONFIGURATION (Native GraphQL)
    // ---------------------------------------------------------
    let userCoaList: any[] = [];
    let userCompanyName: string | null = null;
    let userCompanyTrn: string | null = null;

    try {
      const getQuery = `
        query GetDocumentRecord($userId: String!, $documentId: String!) {
          getDocumentRecord(userId: $userId, documentId: $documentId) {
            chartOfAccounts
            companyName
            companyTrn
          }
        }
      `;
      const configRes = await executeGraphQL(getQuery, { userId, documentId: "CONFIG" });
      const configRecord = configRes?.getDocumentRecord;
      
      if (configRecord) {
        userCompanyName = configRecord.companyName || null;
        userCompanyTrn = configRecord.companyTrn || null;

        if (configRecord.chartOfAccounts) {
          userCoaList = typeof configRecord.chartOfAccounts === 'string' 
            ? JSON.parse(configRecord.chartOfAccounts) 
            : configRecord.chartOfAccounts;
        }
      }
    } catch (err) {
      console.warn("Could not fetch CONFIG record. Proceeding with defaults.", err);
    }

    if (userCoaList.length === 0) {
      userCoaList = [
        { code: "6220", name: "Telephone & Internet" },
        { code: "6260", name: "Fuel Expense" },
        { code: "6330", name: "Software Subscriptions" },
        { code: "6350", name: "Miscellaneous Expenses" }
      ];
    }

    // ---------------------------------------------------------
    // 2. TEXTRACT EXTRACTION
    // ---------------------------------------------------------
    const textractResponse = await textract.send(
      new AnalyzeExpenseCommand({
        Document: { S3Object: { Bucket: bucket, Name: key } }
      })
    );

    let vendorName = "Unknown Vendor";
    let total = 0;
    let tax = 0;
    let subtotal = 0;
    let date = new Date().toISOString().split('T')[0];
    let trn = "NOT_FOUND"; 
    let lowestConfidence = 100;

    const summaryFields = textractResponse.ExpenseDocuments?.[0]?.SummaryFields || [];
    
    summaryFields.forEach(field => {
      const type = field.Type?.Text;
      const val = field.ValueDetection?.Text;
      const conf = field.ValueDetection?.Confidence || 100;

      if (conf < lowestConfidence) lowestConfidence = conf;
      if (type === "VENDOR_NAME" && val) vendorName = val;
      if (type === "TOTAL" && val) total = parseFloat(val.replace(/[^0-9.-]+/g,""));
      if (type === "TAX" && val) tax = parseFloat(val.replace(/[^0-9.-]+/g,""));
      if (type === "SUBTOTAL" && val) subtotal = parseFloat(val.replace(/[^0-9.-]+/g,""));
      if (type === "INVOICE_RECEIPT_DATE" && val) date = val;
      if (type === "RECEIVER_TAX_ID" && val) trn = val;
    });

    const calculatedSubtotal = total - tax;
    const isMathValid = subtotal > 0 
        ? Math.abs((subtotal + tax) - total) < 0.05 
        : Math.abs(calculatedSubtotal + tax - total) < 0.05;

    // ---------------------------------------------------------
    // 3. AI AGENT REASONING (Amazon Bedrock)
    // ---------------------------------------------------------
    let finalCoaCode = "6350";
    let finalCoaName = "Miscellaneous Expenses";

    const promptContext = `
      You are an expert corporate accountant. 
      Analyze this extracted document data:
      - Vendor: ${vendorName}
      - Total Amount: ${total}

      Here is the customer's specific Chart of Accounts (COA):
      ${JSON.stringify(userCoaList, null, 2)}

      Task: Select the single most appropriate COA category for this expense based on the Vendor name.
      You MUST respond with a valid JSON object and nothing else. No markdown, no conversational text.
      Format: {"code": "SELECTED_CODE", "name": "SELECTED_NAME"}
    `;

    try {
      const bedrockResponse = await bedrock.send(
        new ConverseCommand({
          modelId: 'us.amazon.nova-2-lite-v1:0',
          messages: [{ role: 'user', content: [{ text: promptContext }] }]
        })
      );

      let resultText = bedrockResponse.output?.message?.content?.[0]?.text?.trim() || "{}";
      resultText = resultText.replace(/```json/g, '').replace(/```/g, '').trim();
      
      const agentDecision = JSON.parse(resultText);
      if (agentDecision.code && agentDecision.name) {
        finalCoaCode = agentDecision.code;
        finalCoaName = agentDecision.name;
        console.log(`AI Mapped ${vendorName} to ${finalCoaCode} - ${finalCoaName}`);
      }
    } catch (agentErr) {
      console.warn("AI Agent COA mapping failed, falling back to Miscellaneous.", agentErr);
    }

   // ---------------------------------------------------------
    // 4. UPDATE VIA APPSYNC (Triggers Frontend Subscriptions)
    // ---------------------------------------------------------
    const updateMutation = `
      mutation UpdateDocumentRecord($input: UpdateDocumentRecordInput!) {
        updateDocumentRecord(input: $input) {
          userId
          documentId
          companyName
          companyTrn
          recordType
          docType
          status
          s3RawUri
          s3FinalUri
          extractedVendor
          extractedTotal
          extractedTax
          extractedDate
          vendorTRN
          aiConfidenceScore
          isMathValid
          accountantNote
          mappedAccountCode
          mappedAccountName
          createdAt
          updatedAt
          __typename
        }
      }
    `;

    await executeGraphQL(updateMutation, {
      input: {
        userId: userId,
        documentId: documentId,
        companyName: userCompanyName, // 🟢 Stamp Company Name
        companyTrn: userCompanyTrn,   // 🟢 Stamp Company TRN
        extractedVendor: vendorName,
        extractedTotal: total,
        extractedTax: tax,
        extractedDate: date,
        vendorTRN: trn,
        isMathValid: isMathValid,
        aiConfidenceScore: lowestConfidence,
        mappedAccountCode: finalCoaCode,
        mappedAccountName: finalCoaName,
        s3FinalUri: `s3://${bucket}/${key}`, 
        status: "PENDING_CUSTOMER" 
      }
    });

    return { success: true, documentId, status: "PENDING_CUSTOMER" };

  } catch (error) {
    console.error("Extraction workflow failed:", error);
    
    // 🟢 Also fix the failure mutation to return userId!
    try {
      const failMutation = `
        mutation UpdateDocumentRecord($input: UpdateDocumentRecordInput!) {
          updateDocumentRecord(input: $input) { 
            userId
            documentId 
            status 
          }
        }
      `;
      await executeGraphQL(failMutation, {
        input: { userId, documentId, status: "PROCESSING_FAILED" }
      });
    } catch (updateErr) {
      console.error("Could not update failure status in AppSync", updateErr);
    }
    
    throw error;
  }
};