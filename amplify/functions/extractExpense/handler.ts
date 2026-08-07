import { Handler } from 'aws-lambda';
import { TextractClient, AnalyzeExpenseCommand } from '@aws-sdk/client-textract';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';

// 1. Removed the $amplify/env import

const textract = new TextractClient({});
const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

interface ExtractionPayload {
  documentType: string;
  bucket: string;
  key: string;
}

export const handler: Handler<ExtractionPayload> = async (event) => {
  console.log("ExtractExpense triggered:", JSON.stringify(event, null, 2));
  const { documentType, bucket, key } = event;

  // 2. Grab the injected environment variable
  const tableName = process.env.DOCUMENT_TABLE_NAME;
  if (!tableName) {
    throw new Error("DOCUMENT_TABLE_NAME environment variable is not set.");
  }

  // Extract userId and documentId from the S3 Key pattern: private/{userId}/processing/{docType}/{docId}.extension
  const pathParts = key.split('/');
  const userId = pathParts[0]; 
  const fileName = pathParts.pop() || '';
  const documentId = fileName.split('.')[0]; 

  try {
    // 1. Call AWS Textract AnalyzeExpense
    const textractResponse = await textract.send(
      new AnalyzeExpenseCommand({
        Document: { S3Object: { Bucket: bucket, Name: key } }
      })
    );

    // 2. Parse the Summary Fields
    let vendorName = "Unknown Vendor";
    let total = 0;
    let tax = 0;
    let subtotal = 0;
    let date = new Date().toISOString().split('T')[0];
    let trn = "NOT_FOUND"; // Tax Registration Number
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

    // 3. VAT & Math Validation (Crucial for compliance)
    // If Textract didn't find a subtotal, we calculate it to verify the math
    const calculatedSubtotal = total - tax;
    const isMathValid = subtotal > 0 
        ? Math.abs((subtotal + tax) - total) < 0.05 
        : Math.abs(calculatedSubtotal + tax - total) < 0.05;

    // 4. Chart of Accounts (COA) Heuristic Mapping
    const coaMapping = mapToChartOfAccounts(vendorName);

    // 5. Update DynamoDB using the injected table name
    await docClient.send(new UpdateCommand({
      TableName: tableName, // 3. Use the local variable here
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
        ":coaCode": coaMapping.code,
        ":coaName": coaMapping.name,
        // Set to PENDING_CUSTOMER for asynchronous review
        ":s": "PENDING_CUSTOMER" 
      }
    }));

    return { success: true, documentId, status: "PENDING_CUSTOMER" };

  } catch (error) {
    console.error("Extraction failed:", error);
    throw error;
  }
};

// Lightweight Account Routing based on your SME COA
function mapToChartOfAccounts(vendor: string): { code: string, name: string } {
  const v = vendor.toLowerCase();
  
  if (v.includes('aws') || v.includes('github') || v.includes('n8n')) {
    return { code: '6330', name: 'Software Subscriptions' };
  }
  if (v.includes('stc') || v.includes('batelco') || v.includes('zain')) {
    return { code: '6220', name: 'Telephone & Internet' };
  }
  if (v.includes('fuel') || v.includes('gas') || v.includes('excellence')) {
    return { code: '6260', name: 'Fuel Expense' };
  }
  if (v.includes('booking') || v.includes('agoda') || v.includes('airbnb') || v.includes('hotel')) {
    return { code: '6290', name: 'Travel & Entertainment' };
  }
  if (v.includes('starbucks') || v.includes('restaurant')) {
    return { code: '6290', name: 'Travel & Entertainment' }; // Client meetings
  }
  
  // Default fallback for Accountant review
  return { code: '6350', name: 'Miscellaneous Expenses' }; 
}