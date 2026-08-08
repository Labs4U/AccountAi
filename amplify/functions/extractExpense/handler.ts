import { Handler } from 'aws-lambda';
import { TextractClient, AnalyzeExpenseCommand } from '@aws-sdk/client-textract';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

const textract = new TextractClient({});
const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);
const bedrock = new BedrockRuntimeClient({});

interface ExtractionPayload {
  documentType: string;
  bucket: string;
  key: string;
}

export const handler: Handler<ExtractionPayload> = async (event) => {
  console.log("ExtractExpense triggered:", JSON.stringify(event, null, 2));
  const { bucket, key } = event;

  const tableName = process.env.DOCUMENT_TABLE_NAME;
  if (!tableName) {
    throw new Error("DOCUMENT_TABLE_NAME environment variable is not set.");
  }

  // Extract userId and documentId from the S3 Key pattern: {userId}/invoice/{docId}.extension
  const pathParts = key.split('/');
  const userId = pathParts[0]; 
  const fileName = pathParts.pop() || '';
  const documentId = fileName.split('.')[0]; 

  try {
    // ---------------------------------------------------------
    // 1. FETCH CUSTOMER CONFIGURATION (Single Table Design)
    // ---------------------------------------------------------
    let userCoaList = [];
    try {
      const configRecord = await docClient.send(new GetCommand({
        TableName: tableName,
        Key: { userId, documentId: "CONFIG" }
      }));
      
      if (configRecord.Item && configRecord.Item.chartOfAccounts) {
        userCoaList = configRecord.Item.chartOfAccounts;
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
          modelId: 'us.amazon.nova-2-lite-v1:0', // You can change this to Haiku or Claude 3.5 Sonnet
          messages: [
            {
              role: 'user',
              content: [{ text: promptContext }]
            }
          ]
        })
      );

      // Clean up the response (LLMs sometimes wrap JSON in markdown blocks)
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
    // 4. UPDATE DYNAMODB
    // ---------------------------------------------------------
    await docClient.send(new UpdateCommand({
      TableName: tableName,
      Key: { userId, documentId },
      UpdateExpression: `SET 
        extractedVendor = :v, 
        extractedTotal = :t, 
        extractedTax = :tx, 
        extractedDate = :d, 
        vendorTRN = :trn,
        isMathValid = :math,
        aiConfidenceScore = :conf,
        mappedAccountCode = :coaCode,
        mappedAccountName = :coaName,
        s3FinalUri = :finalUri, 
        #status = :s`,
      ExpressionAttributeNames: {
        "#status": "status"
      },
      ExpressionAttributeValues: {
        ":v": vendorName,
        ":t": total,
        ":tx": tax,
        ":d": date,
        ":trn": trn,
        ":math": isMathValid,
        ":conf": lowestConfidence,
        ":coaCode": finalCoaCode,
        ":coaName": finalCoaName,
        ":finalUri": `s3://${bucket}/${key}`, 
        ":s": "PENDING_CUSTOMER" 
      }
    }));

    return { success: true, documentId, status: "PENDING_CUSTOMER" };

  } catch (error) {
    console.error("Extraction workflow failed:", error);
    throw error;
  }
};