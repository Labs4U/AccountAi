import { S3Client, CopyObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client();

export async function moveDocumentToCategoryFolder(
  bucketName: string,
  sourceKey: string,
  confirmedCategory: "INVOICE" | "RECEIPT" | "OTHER"
): Promise<string> {
  // Extract file name from the S3 key path
  const keyParts = sourceKey.split('/');
  const fileName = keyParts.pop() || 'document.pdf';

  // Construct target key replacing '/raw/' or appending category
  const categoryFolder = confirmedCategory.toLowerCase();
  const targetKey = sourceKey.includes('/raw/')
    ? sourceKey.replace('/raw/', `/${categoryFolder}/`)
    : `${keyParts.join('/')}/${categoryFolder}/${fileName}`;

  try {
    // 1. Copy object to category folder
    await s3.send(
      new CopyObjectCommand({
        Bucket: bucketName,
        CopySource: `${bucketName}/${sourceKey}`,
        Key: targetKey,
      })
    );

    // 2. Delete original object from raw landing folder
    await s3.send(
      new DeleteObjectCommand({
        Bucket: bucketName,
        Key: sourceKey,
      })
    );

    console.log(`Successfully moved s3://${bucketName}/${sourceKey} to s3://${bucketName}/${targetKey}`);
    return targetKey;
  } catch (error) {
    console.error("Failed to move S3 object:", error);
    throw error;
  }
}