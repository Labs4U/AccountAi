import { Handler } from 'aws-lambda';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({});

const executeGraphQL = async (query: string, variables: any) => {
  const endpoint = process.env.AMPLIFY_DATA_GRAPHQL_ENDPOINT;
  const apiKey = process.env.AMPLIFY_DATA_GRAPHQL_API_KEY;

  if (!endpoint || !apiKey) throw new Error("Missing AppSync environment variables.");

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ query, variables })
  });

  const json = await response.json();
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data;
};

export const handler: Handler = async (event) => {
  console.log("Compliance Report Generation Triggered", JSON.stringify(event));

  const bucketName = process.env.BUCKET_NAME;
  if (!bucketName) throw new Error("Missing BUCKET_NAME environment variable.");

  // Timetable Calculation (For Production)
  const now = new Date();
  now.setMonth(now.getMonth() - 1);
  const targetYearMonth = now.toISOString().slice(0, 7); // "YYYY-MM"
  const targetYear = targetYearMonth.split('-')[0];
  const quarter = Math.ceil(parseInt(targetYearMonth.split('-')[1], 10) / 3);

  try {
    // 1. Fetch all Company Profiles to organize reports by client
    const profileQuery = `
      query ListProfiles {
        listDocumentRecord(filter: { documentId: { eq: "CONFIG" } }) {
          items { userId, companyName }
        }
      }
    `;
    const profileData = await executeGraphQL(profileQuery, {});
    const companies = profileData?.listDocumentRecord?.items || [];

    if (companies.length === 0) return { success: true, message: "No companies configured." };

    let reportsGenerated = 0;

    // 2. Process reports per company
    for (const company of companies) {
      const userId = company.userId;
      const sanitizedCompany = (company.companyName || "UnknownCompany").replace(/[^a-zA-Z0-9_-]/g, "_");

      // Fetch all FINALIZED documents for this user
      const docsQuery = `
        query ListUserFinalized($userId: String!) {
          listDocumentRecord(filter: { userId: { eq: "$userId" }, status: { eq: "FINALIZED" } }) {
            items {
              documentId
              extractedVendor
              extractedTotal
              extractedTax
              extractedDate
              vendorTRN
              mappedAccountCode
              mappedAccountName
              status
              createdAt
            }
          }
        }
      `.replace("$userId", userId);

      const docsData = await executeGraphQL(docsQuery, {});
      const allUserDocs = docsData?.listDocumentRecord?.items || [];

      // ====================================================================
      // ⚠️ POC OVERRIDE: 
      // In production, this should be: allUserDocs.filter(d => d.createdAt.startsWith(targetYearMonth))
      // For the POC, we are forcefully grabbing ALL finalized documents.
      // ====================================================================
      const docsToProcess = allUserDocs; 
      
      if (docsToProcess.length === 0) {
        console.log(`No finalized documents for ${sanitizedCompany}. Skipping.`);
        continue;
      }

      // --- REPORT 1: Management Accounts (Business Health / Monthly) ---
      let mgmtCsv = "DocumentID,Vendor,Date,Total_Expense,COA_Category\n";
      docsToProcess.forEach(r => {
        mgmtCsv += `"${r.documentId}","${r.extractedVendor || ''}","${r.extractedDate || ''}",${r.extractedTotal || 0},"${r.mappedAccountName || ''}"\n`;
      });

      // --- REPORT 2: The VAT Return (NBR Compliance / Quarterly or Monthly) ---
      // Focused strictly on recoverable tax and TRNs
      let vatCsv = "DocumentID,Vendor,VendorTRN,Date,TotalGross,TaxRecoverable\n";
      docsToProcess.forEach(r => {
        vatCsv += `"${r.documentId}","${r.extractedVendor || ''}","${r.vendorTRN || 'NOT_FOUND'}","${r.extractedDate || ''}",${r.extractedTotal || 0},${r.extractedTax || 0}\n`;
      });

      // --- REPORT 3: Audited Financial Statements (MOIC Compliance / Annual) ---
      // A comprehensive master ledger mapping every transaction to its specific COA code for IFRS auditing
      let moicCsv = "DocumentID,TransactionDate,Vendor,TotalAmount,TaxAmount,NetAmount,COA_Code,COA_Name,AuditStatus\n";
      docsToProcess.forEach(r => {
        const net = (r.extractedTotal || 0) - (r.extractedTax || 0);
        moicCsv += `"${r.documentId}","${r.extractedDate || ''}","${r.extractedVendor || ''}",${r.extractedTotal || 0},${r.extractedTax || 0},${net},"${r.mappedAccountCode || ''}","${r.mappedAccountName || ''}","${r.status}"\n`;
      });

      // 3. Upload to Structured S3 Paths
      const basePrefix = `reports/${userId}_${sanitizedCompany}/${targetYear}`;

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
    }

    return { success: true, message: "POC Reports Generated Successfully!", companiesProcessed: reportsGenerated };

  } catch (error) {
    console.error("Failed to generate compliance reports:", error);
    throw error;
  }
};