import { Handler } from 'aws-lambda';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { moveDocumentToCategoryFolder } from './moveS3Object';
import { env } from '$amplify/env/classifyDocument';
const bedrock = new BedrockRuntimeClient({});

interface S3EventDetail {
  bucket: { name: string };
  object: { key: string };
}

interface StepFunctionInput {
  detail?: S3EventDetail;
}

export const handler: Handler<StepFunctionInput> = async (event) => {
  console.log("ClassifyDocument triggered with event:", JSON.stringify(event, null, 2));

  const bucket = event.detail?.bucket?.name;
  const key = event.detail?.object?.key;

  if (!bucket || !key) {
    throw new Error("Invalid event payload: Missing bucket or key.");
  }

  const modelId = env.MODEL_ID || 'us.amazon.nova-2-lite-v1:0';

  try {
    let documentType: "INVOICE" | "RECEIPT" | "OTHER" = "INVOICE";
    const lowerKey = key.toLowerCase();

    // 1. Quick local check
    if (lowerKey.includes('receipt')) {
      documentType = 'RECEIPT';
    } else if (lowerKey.includes('invoice')) {
      documentType = 'INVOICE';
    } else {
      // 2. Call Amazon Bedrock Nova Lite using Converse API
      try {
        const bedrockResponse = await bedrock.send(
          new ConverseCommand({
            modelId: modelId,
            messages: [
              {
                role: 'user',
                content: [
                  {
                    text: `Classify this document file named "${key}". Respond ONLY with one exact word: INVOICE, RECEIPT, or OTHER.`
                  }
                ]
              }
            ]
          })
        );

        const resultText = bedrockResponse.output?.message?.content?.[0]?.text?.trim().toUpperCase();
        if (resultText === 'RECEIPT' || resultText === 'INVOICE' || resultText === 'OTHER') {
          documentType = resultText;
        }
      } catch (bedrockErr) {
        console.warn("Bedrock classification fallback to default INVOICE:", bedrockErr);
      }
    }

    // 3. Move file from raw to designated category folder in S3
    let targetKey = key;
    try {
      targetKey = await moveDocumentToCategoryFolder(bucket, key, documentType);
    } catch (moveErr) {
      console.warn("Skipped or failed object relocation, proceeding with original key:", moveErr);
    }

    console.log(`Classified document s3://${bucket}/${targetKey} as ${documentType}`);

    return {
      documentType,
      bucket,
      key: targetKey,
      originalKey: key
    };

  } catch (error) {
    console.error("Classification failed:", error);
    throw error;
  }
};