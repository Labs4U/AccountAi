import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

const client = new BedrockRuntimeClient();

export const handler = async (event: any) => {
  console.log("Received event:", JSON.stringify(event, null, 2));

  let s3Key = "";
  let documentId = "";

  // 1. Smart extraction: Handle both direct S3 triggers and Step Function payloads
  if (event.Records && event.Records[0].s3) {
    // Source: Direct S3 Event Notification
    // Decode the key in case of spaces or special characters in the filename
    s3Key = decodeURIComponent(event.Records[0].s3.object.key.replace(/\+/g, " "));
    
    // Extract documentId from filename (e.g., from "{SUB}/raw/doc-12345.pdf" -> "doc-12345")
    const fileName = s3Key.split('/').pop() || "";
    documentId = fileName.split('.')[0] || "unknown-doc-id";
    
  } else if (event.s3Key) {
    // Source: Step Functions orchestrated flow
    s3Key = event.s3Key;
    documentId = event.documentId || "unknown-doc-id";
    
  } else {
    console.error("Unrecognized event format");
    throw new Error("Unrecognized event format. Missing s3Key.");
  }

  // 2. INFINITE LOOP PROTECTION
  // Stop execution immediately if the file is NOT in a /raw/ folder
  if (!s3Key.includes('/raw/')) {
    console.log(`Ignoring object ${s3Key} as it is not in the /raw/ landing folder.`);
    // Return early without calling Bedrock
    return { 
      status: "IGNORED", 
      message: "File not in /raw/ folder. Ignored to prevent infinite loops." 
    };
  }

  console.log(`Processing documentId: ${documentId} with key: ${s3Key}`);

  // 3. Document Classification Request
  const prompt = `Classify this document into one of the following categories: INVOICE, RECEIPT, or OTHER. Respond with ONLY the category name.`;

  const command = new ConverseCommand({
    modelId: "us.amazon.nova-2-lite-v1:0",
    messages: [
      {
        role: "user",
        content: [{ text: prompt }]
        // Note: In production, you will fetch the S3 object and pass the image bytes here
      }
    ]
  });

  try {
    const response = await client.send(command);
    const classification = response.output?.message?.content?.[0]?.text?.trim() || "OTHER";
    
    return {
      documentId,
      classification,
      status: 'PENDING_CLASS'
    };
  } catch (error) {
    console.error("Bedrock classification failed", error);
    throw error;
  }
};