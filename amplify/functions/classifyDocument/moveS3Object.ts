import { S3Client, CopyObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client();
const BUCKET_NAME = "account-ai-bh";

export async function moveDocumentToCategoryFolder(
  userSub: string,
  fileName: string,
  confirmedCategory: "INVOICE" | "RECEIPT" | "OTHER"
): Promise<string> {
  const sourceKey = `${userSub}/raw/${fileName}`;
  const targetKey = `${userSub}/${confirmedCategory}/${fileName}`;

  try {
    // 1. Copy object to category folder
    await s3.send(
      new CopyObjectCommand({
        Bucket: BUCKET_NAME,
        CopySource: `${BUCKET_NAME}/${sourceKey}`,
        Key: targetKey,
      })
    );

    // 2. Delete original object from raw landing folder
    await s3.send(
      new DeleteObjectCommand({
        Bucket: BUCKET_NAME,
        Key: sourceKey,
      })
    );

    console.log(`Successfully moved ${sourceKey} to ${targetKey}`);
    return `s3://${BUCKET_NAME}/${targetKey}`;
  } catch (error) {
    console.error("Failed to move S3 object:", error);
    throw error;
  }
}