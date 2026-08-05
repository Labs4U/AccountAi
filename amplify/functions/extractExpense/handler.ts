import { TextractClient, AnalyzeExpenseCommand } from "@aws-sdk/client-textract";

const client = new TextractClient();

// --- 1. The Parser Helper Function ---
const parseTextractExpense = (expenseDocuments: any[]) => {
  // Initialize a clean, flat object
  const parsedData = {
    vendorName: "Unknown Vendor",
    total: 0,
    tax: 0,
    date: "",
    confidenceScores: {} as Record<string, number>,
  };

  if (!expenseDocuments || expenseDocuments.length === 0) return parsedData;

  // Textract can return multiple documents in one image, we'll take the first one
  const doc = expenseDocuments[0];

  // Loop through the messy SummaryFields to find exactly what we want
  if (doc.SummaryFields) {
    doc.SummaryFields.forEach((field: any) => {
      const type = field.Type?.Text; // e.g., 'VENDOR_NAME', 'TOTAL'
      const value = field.ValueDetection?.Text; // The actual extracted text
      const confidence = field.ValueDetection?.Confidence;

      if (type && value) {
        switch (type) {
          case "VENDOR_NAME":
            parsedData.vendorName = value;
            parsedData.confidenceScores.vendorName = confidence;
            break;
          case "TOTAL":
            // Strip out currency symbols and convert to number
            parsedData.total = parseFloat(value.replace(/[^0-9.-]+/g, ""));
            parsedData.confidenceScores.total = confidence;
            break;
          case "TAX":
            parsedData.tax = parseFloat(value.replace(/[^0-9.-]+/g, ""));
            parsedData.confidenceScores.tax = confidence;
            break;
          case "INVOICE_RECEIPT_DATE":
            parsedData.date = value;
            parsedData.confidenceScores.date = confidence;
            break;
        }
      }
    });
  }

  return parsedData;
};

// --- 2. The Main Lambda Handler ---
export const handler = async (event: any) => {
  console.log("Extraction event:", JSON.stringify(event, null, 2));

  const s3Uri = event.s3Uri; 
  const documentId = event.documentId;
  const userId = event.userId;

  if (!s3Uri) throw new Error("Missing S3 URI for Textract processing.");

  const bucketName = s3Uri.split("/")[2];
  const objectKey = s3Uri.split("/").slice(3).join("/");

  const command = new AnalyzeExpenseCommand({
    Document: {
      S3Object: {
        Bucket: bucketName,
        Name: objectKey,
      },
    },
  });

  try {
    // Call AWS Textract
    const response = await client.send(command);
    
    // Pass the messy data through our Parser
    const flattenedData = parseTextractExpense(response.ExpenseDocuments || []);
    
    console.log("Parsed Data:", flattenedData);

    // Return the clean data (This will eventually be caught by Step Functions)
    return {
      documentId,
      userId,
      status: "PENDING_EXTRACTION",
      extractedData: flattenedData // <--- Clean, flat JSON ready for the UI
    };
  } catch (error) {
    console.error("Textract AnalyzeExpense failed", error);
    throw error;
  }
};