import { Handler } from 'aws-lambda';
import { TextractClient, AnalyzeExpenseCommand } from '@aws-sdk/client-textract';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '../../data/resource';

// ---------------------------------------------------------
// 1. CONFIGURE APPSYNC CLIENT FOR BACKEND IAM AUTHORIZATION
// ---------------------------------------------------------
Amplify.configure({
  API: {
    GraphQL: {
      endpoint: process.env.AMPLIFY_DATA_GRAPHQL_ENDPOINT as string,
      region: process.env.AWS_REGION as string,
      defaultAuthMode: 'apiKey',
      apiKey: process.env.AMPLIFY_DATA_GRAPHQL_API_KEY as string
    }
  }
});

const dataClient = generateClient<Schema>();
const textract = new TextractClient({});
const bedrock = new BedrockRuntimeClient({});

interface ExtractionPayload {
  documentType: string;
  bucket: string;
  key: string;
}

export const handler: Handler<ExtractionPayload> = async (event) => {
  console.log("ExtractExpense triggered:", JSON.stringify(event, null, 2));
  const { bucket, key } = event;

  // Extract userId and documentId from the S3 Key pattern: {userId}/invoice/{docId}.extension
  const pathParts = key.split('/');
  const userId = pathParts[0]; 
  const fileName = pathParts.pop() || '';
  const documentId = fileName.split('.')[0]; 

  try {
    // ---------------------------------------------------------
    // 2. FETCH CUSTOMER CONFIGURATION (Via AppSync)
    // ---------------------------------------------------------
    let userCoaList: any[] = [];
    try {
      const { data: configRecord } = await dataClient.models.DocumentRecord.get({
        userId: userId,
        documentId: "CONFIG"
      });
      
      if (configRecord && configRecord.chartOfAccounts) {
        // AppSync AWSJSON fields come back as stringified JSON, so we parse it safely
        userCoaList = typeof configRecord.chartOfAccounts === 'string' 
          ? JSON.parse(configRecord.chartOfAccounts) 
          : configRecord.chartOfAccounts;
      }
    } catch (err) {
      console.warn("Could not fetch CONFIG record. Proceeding with defaults.", err);
    }

    // Default fallback COA if customer hasn't set one up yet
    if (userCoaList.length === 0) {
      userCoaList = [
        { code: "6220", name: "Telephone & Internet" },
        { code: "6260", name: "Fuel Expense" },
        { code: "6330", name: "Software Subscriptions" },
        { code: "6350", name: "Miscellaneous Expenses" }
      ];
    }

    // ---------------------------------------------------------
    // 3. TEXTRACT EXTRACTION
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
    // 4. AI AGENT REASONING (Amazon Bedrock)
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
          messages: [
            { role: 'user', content: [{ text: promptContext }] }
          ]
        })
      );

      let resultText = bedrockResponse.output?.message?.content?.[0]?.text?.trim() || "{}";
      resultText = resultText.replace(/```json/g, '').replace(/```/g, '').trim();
      
      const agentDecision = JSON.parse(resultText);
      if (agentDecision.code && agentDecision.name) {
        finalCoaCode = agentDecision.code;
        finalCoaName = agentDecision.name;
        console.log(`AI Agent successfully mapped ${vendorName} to ${finalCoaCode} - ${finalCoaName}`);
      }
    } catch (agentErr) {
      console.warn("AI Agent COA mapping failed, falling back to Miscellaneous.", agentErr);
    }

    // ---------------------------------------------------------
    // 5. UPDATE VIA APPSYNC (Triggers Frontend Subscriptions)
    // ---------------------------------------------------------
    await dataClient.models.DocumentRecord.update({
      userId: userId,
      documentId: documentId,
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
    });

    return { success: true, documentId, status: "PENDING_CUSTOMER" };

  } catch (error) {
    console.error("Extraction workflow failed:", error);
    
    // Attempt to update status to FAILED via AppSync so the UI knows something went wrong
    try {
      await dataClient.models.DocumentRecord.update({
        userId: userId,
        documentId: documentId,
        status: "PROCESSING_FAILED" 
      });
    } catch (updateErr) {
      console.error("Could not update failure status in AppSync", updateErr);
    }
    
    throw error;
  }
};