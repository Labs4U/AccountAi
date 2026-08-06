import { Handler } from 'aws-lambda';

interface ExtractionPayload {
  documentType: string;
  bucket: string;
  key: string;
}

export const handler: Handler<ExtractionPayload> = async (event) => {
  console.log("ExtractExpense triggered with payload:", JSON.stringify(event, null, 2));

  const { documentType, bucket, key } = event;

  if (!bucket || !key) {
    throw new Error("Missing bucket or key in extraction payload.");
  }

  console.log(`Extracting expense data via AWS Textract for ${documentType} from s3://${bucket}/${key}`);

  try {
    // Simulated Textract Async Output
    const mockRawTextractJson = {
      JobStatus: "SUCCEEDED",
      DocumentMetadata: { Pages: 1 },
      ExpenseDocuments: [
        {
          SummaryFields: [
            { Type: { Text: "VENDOR_NAME" }, ValueDetection: { Text: "AWS Services" } },
            { Type: { Text: "TOTAL" }, ValueDetection: { Text: "150.00" } }
          ]
        }
      ]
    };

    console.log("Extraction completed successfully.");

    return {
      textractStatus: mockRawTextractJson.JobStatus,
      rawOutputRef: `s3://${bucket}/${key}.textract.json`,
      summaryFields: mockRawTextractJson.ExpenseDocuments[0].SummaryFields
    };

  } catch (error) {
    console.error("Expense extraction failed:", error);
    throw error;
  }
};