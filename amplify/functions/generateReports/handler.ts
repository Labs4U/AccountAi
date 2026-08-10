import { Handler } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const ddbClient = new DynamoDBClient({});
const dynamo = DynamoDBDocumentClient.from(ddbClient);
const s3 = new S3Client({});

export const handler: Handler = async (event) => {
  console.log("Direct-DB POC Report Generation Triggered", JSON.stringify(event));

  // 🟢 Explicitly using your table name
  const tableName = "DocumentRecord-ernvgsc7uzfipmoevatlefca7i-NONE";
  const bucketName = process.env.BUCKET_NAME || 'account-ai-bh';

  try {
    console.log(`Scanning DynamoDB Table: ${tableName}`);

    // Direct scan of your exact table
    const scanResult = await dynamo.send(
      new ScanCommand({ TableName: tableName })
    );

    const allItems = scanResult.Items || [];
    console.log(`Total items retrieved from table: ${allItems.length}`);
    
    // Log statuses to verify records in CloudWatch
    allItems.forEach(item => {
      if (item.documentId !== "CONFIG") {
        console.log(`Doc ID: ${item.documentId}, Status Found: '${item.status}'`);
      }
    });

    // Extract Company Name mapping from CONFIG records
    const companyMap: Record<string, string> = {};
    allItems
      .filter(r => r.documentId === "CONFIG")
      .forEach(r => {
        if (r.userId && r.companyName) {
          companyMap[r.userId] = r.companyName;
        }
      });

    // Flexible match for Finalized documents (case-insensitive)
    const finalizedDocs = allItems.filter(r => {
      const statusStr = (r.status || "").trim().toUpperCase();
      return statusStr === "FINALIZED" && r.documentId !== "CONFIG";
    });

    console.log(`Matched ${finalizedDocs.length} finalized documents.`);

    if (finalizedDocs.length === 0) {
      return { 
        success: true, 
        message: `Scanned table successfully, but found 0 finalized documents out of ${allItems.length} total rows.` 
      };
    }

    // Group finalized documents by userId
    const docsByUser: Record<string, any[]> = {};
    finalizedDocs.forEach(doc => {
      if (!docsByUser[doc.userId]) docsByUser[doc.userId] = [];
      docsByUser[doc.userId].push(doc);
    });

    let reportsGenerated = 0;
    const currentYear = new Date().getFullYear().toString();

    // Generate and upload reports per company
    for (const [userId, docs] of Object.entries(docsByUser)) {
      const companyName = companyMap[userId] || docs[0].companyName || "UnknownCompany";
      const sanitizedCompany = companyName.replace(/[^a-zA-Z0-9_-]/g, "_");

      // --- REPORT 1: Management Accounts ---
      let mgmtCsv = "DocumentID,Vendor,Date,Total_Expense,COA_Category\n";
      docs.forEach(r => {
        mgmtCsv += `"${r.documentId}","${r.extractedVendor || ''}","${r.extractedDate || ''}",${r.extractedTotal || 0},"${r.mappedAccountName || ''}"\n`;
      });

      // --- REPORT 2: VAT Return ---
      let vatCsv = "DocumentID,Vendor,VendorTRN,Date,TotalGross,TaxRecoverable\n";
      docs.forEach(r => {
        vatCsv += `"${r.documentId}","${r.extractedVendor || ''}","${r.vendorTRN || 'NOT_FOUND'}","${r.extractedDate || ''}",${r.extractedTotal || 0},${r.extractedTax || 0}\n`;
      });

      // --- REPORT 3: Audited Financial Statements ---
      let moicCsv = "DocumentID,TransactionDate,Vendor,TotalAmount,TaxAmount,NetAmount,COA_Code,COA_Name,AuditStatus\n";
      docs.forEach(r => {
        const net = (r.extractedTotal || 0) - (r.extractedTax || 0);
        moicCsv += `"${r.documentId}","${r.extractedDate || ''}","${r.extractedVendor || ''}",${r.extractedTotal || 0},${r.extractedTax || 0},${net},"${r.mappedAccountCode || ''}","${r.mappedAccountName || ''}","${r.status}"\n`;
      });

      // Upload to Structured S3 Paths
      const basePrefix = `reports/${userId}_${sanitizedCompany}/${currentYear}`;

      await s3.send(new PutObjectCommand({
        Bucket: bucketName, Key: `${basePrefix}/management/Management_Accounts_POC.csv`, Body: mgmtCsv, ContentType: 'text/csv'
      }));

      await s3.send(new PutObjectCommand({
        Bucket: bucketName, Key: `${basePrefix}/nbr/VAT_Return_POC.csv`, Body: vatCsv, ContentType: 'text/csv'
      }));

      await s3.send(new PutObjectCommand({
        Bucket: bucketName, Key: `${basePrefix}/moic/Audited_Financials_Master_Ledger_POC.csv`, Body: moicCsv, ContentType: 'text/csv'
      }));

      reportsGenerated++;
      console.log(`Successfully compiled reports for ${companyName}`);
    }

    return { 
      success: true, 
      message: `Successfully generated POC reports for ${reportsGenerated} company/companies!`, 
      finalizedCount: finalizedDocs.length 
    };

  } catch (error: any) {
    console.error("Failed to generate POC compliance reports:", error);
    return { success: false, error: error.message || String(error) };
  }
};