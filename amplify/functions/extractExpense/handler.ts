import { Handler } from 'aws-lambda';
import { TextractClient, StartExpenseAnalysisCommand, GetExpenseAnalysisCommand } from '@aws-sdk/client-textract';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

const textract = new TextractClient({});
const bedrock = new BedrockRuntimeClient({});

// ---------------------------------------------------------
// HELPER: NATIVE GRAPHQL FETCH
// ---------------------------------------------------------
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

interface ExtractionPayload {
  documentType: string;
  bucket: string;
  key: string;
}

export const handler: Handler<ExtractionPayload> = async (event) => {
  console.log("ExtractExpense triggered:", JSON.stringify(event, null, 2));
  const { bucket, key } = event;

  const pathParts = key.split('/');
  const userId = pathParts[0]; 
  const fileName = pathParts.pop() || '';
  const documentId = fileName.split('.')[0]; 

  try {
    // ---------------------------------------------------------
    // 1. FETCH CUSTOMER CONFIGURATION
    // ---------------------------------------------------------
    let userCoaList: any[] = [];
    let userCompanyName: string | null = null;
    let userCompanyTrn: string | null = null;
    let userAccountantId: string | null = null;

    try {
      const getQuery = `
        query GetDocumentRecord($userId: String!, $documentId: String!) {
          getDocumentRecord(userId: $userId, documentId: $documentId) {
            chartOfAccounts companyName companyTrn accountantId
          }
        }
      `;
      const configRes = await executeGraphQL(getQuery, { userId, documentId: "CUST" });
      const configRecord = configRes?.getDocumentRecord;
      
      if (configRecord) {
        userCompanyName = configRecord.companyName || null;
        userCompanyTrn = configRecord.companyTrn || null;
        userAccountantId = configRecord.accountantId || null;
        if (configRecord.chartOfAccounts) {
          userCoaList = typeof configRecord.chartOfAccounts === 'string' ? JSON.parse(configRecord.chartOfAccounts) : configRecord.chartOfAccounts;
        }
      }

      if (userCoaList.length === 0) {
        const sysRes = await executeGraphQL(getQuery, { userId: "SYSTEM", documentId: "DEFAULT_COA" });
        const sysRecord = sysRes?.getDocumentRecord;
        if (sysRecord && sysRecord.chartOfAccounts) {
           userCoaList = typeof sysRecord.chartOfAccounts === 'string' ? JSON.parse(sysRecord.chartOfAccounts) : sysRecord.chartOfAccounts;
        }
      }
    } catch (err) {
      console.warn("Could not fetch records. Proceeding with defaults.", err);
    }

    if (userCoaList.length === 0) {
      userCoaList = [{ code: "6350", name: "Miscellaneous Expenses" }];
    }

    // ---------------------------------------------------------
    // 2. TEXTRACT ASYNC EXTRACTION (POLLING)
    // ---------------------------------------------------------
    let textractResponse: any;
    try {
      const startRes = await textract.send(new StartExpenseAnalysisCommand({
        DocumentLocation: { S3Object: { Bucket: bucket, Name: key } }
      }));
      
      const jobId = startRes.JobId;
      console.log(`Started Async Textract Job: ${jobId}`);

      let jobStatus = "IN_PROGRESS";
      while (jobStatus === "IN_PROGRESS") {
        await new Promise(resolve => setTimeout(resolve, 3000));
        const getRes = await textract.send(new GetExpenseAnalysisCommand({ JobId: jobId }));
        jobStatus = getRes.JobStatus || "FAILED";
        if (jobStatus === "SUCCEEDED") textractResponse = getRes;
        else if (jobStatus === "FAILED" || jobStatus === "PARTIAL_SUCCESS") throw new Error(`Async Job failed: ${jobStatus}`);
      }
    } catch (textractErr: any) {
      console.error("Textract Failed:", textractErr);
      throw textractErr;
    }

    const expenseDocs = textractResponse.ExpenseDocuments || [];
    if (expenseDocs.length === 0) throw new Error("No invoices found in the document.");

    // ---------------------------------------------------------
    // 2.5 🟢 NEW: CONSOLIDATE MULTI-PAGE INVOICES 
    // ---------------------------------------------------------
    const consolidatedInvoices: Record<string, any> = {};
    let currentInvoiceId = "unknown_0";
    let unknownCounter = 0;

    expenseDocs.forEach((doc: any, index: number) => {
      let pageInvoiceId = null;
      let vendorName = null;
      let total = 0; let tax = 0; let subtotal = 0;
      let date = null; let trn = null; let lowestConfidence = 100;
      let purchasedItems: string[] = [];

      (doc.SummaryFields || []).forEach((field: any) => {
        const type = field.Type?.Text;
        const val = field.ValueDetection?.Text;
        const conf = field.ValueDetection?.Confidence || 100;

        if (conf < lowestConfidence) lowestConfidence = conf;
        
        if (type === "INVOICE_RECEIPT_ID" && val) pageInvoiceId = val;
        if (type === "VENDOR_NAME" && val) vendorName = val;
        if (type === "TOTAL" && val) total = parseFloat(val.replace(/[^0-9.-]+/g,""));
        if (type === "TAX" && val) tax = parseFloat(val.replace(/[^0-9.-]+/g,""));
        if (type === "SUBTOTAL" && val) subtotal = parseFloat(val.replace(/[^0-9.-]+/g,""));
        if (type === "INVOICE_RECEIPT_DATE" && val) date = val;
        if (type === "RECEIVER_TAX_ID" && val) trn = val;
      });

      (doc.LineItemGroups || []).forEach((group: any) => {
        group.LineItems?.forEach((item: any) => {
          const itemDesc = item.LineItemExpenseFields?.find((f: any) => f.Type?.Text === "ITEM")?.ValueDetection?.Text;
          if (itemDesc) purchasedItems.push(itemDesc);
        });
      });

      // Grouping Logic: Track pages by Invoice Number or Sequential Flow
      if (pageInvoiceId) {
        currentInvoiceId = pageInvoiceId;
      } else if (index === 0) {
        currentInvoiceId = `unknown_${unknownCounter++}`;
      }

      if (!consolidatedInvoices[currentInvoiceId]) {
        // Create new consolidated invoice
        consolidatedInvoices[currentInvoiceId] = {
          vendorName: vendorName || "Unknown Vendor",
          total: total || 0,
          tax: tax || 0,
          subtotal: subtotal || 0,
          date: date,
          trn: trn || "NOT_FOUND",
          lowestConfidence: lowestConfidence,
          purchasedItems: [...purchasedItems]
        };
      } else {
        // Merge subsequent pages into the existing invoice
        const inv = consolidatedInvoices[currentInvoiceId];
        if (vendorName && inv.vendorName === "Unknown Vendor") inv.vendorName = vendorName;
        if (date && !inv.date) inv.date = date;
        if (trn && inv.trn === "NOT_FOUND") inv.trn = trn;
        
        inv.total = Math.max(inv.total, total || 0);
        inv.tax = Math.max(inv.tax, tax || 0);
        inv.subtotal = Math.max(inv.subtotal, subtotal || 0);
        inv.lowestConfidence = Math.min(inv.lowestConfidence, lowestConfidence);
        inv.purchasedItems.push(...purchasedItems);
      }
    });

    const finalInvoicesToProcess = Object.values(consolidatedInvoices);
    console.log(`Consolidated ${expenseDocs.length} raw pages into ${finalInvoicesToProcess.length} distinct invoice records.`);

    // ---------------------------------------------------------
    // 3. PROCESS EACH CONSOLIDATED INVOICE SEPARATELY
    // ---------------------------------------------------------
    for (let i = 0; i < finalInvoicesToProcess.length; i++) {
      const inv = finalInvoicesToProcess[i];
      const purchasedItemsStr = inv.purchasedItems.length > 0 ? inv.purchasedItems.join(", ") : "Unspecified";
      const invoiceDate = inv.date || new Date().toISOString().split('T')[0];
      const isMathValid = inv.subtotal > 0 ? Math.abs((inv.subtotal + inv.tax) - inv.total) < 0.05 : Math.abs((inv.total - inv.tax) + inv.tax - inv.total) < 0.05;

      // --- RAG (Memory) ---
      let historicalContext = "No previous history.";
      if (inv.vendorName !== "Unknown Vendor") {
        try {
          const historyQuery = `query ListHistoricalDocs($userId: String!) { listDocumentRecords(filter: { userId: { eq: $userId }, status: { eq: "FINALIZED" } }, limit: 100) { items { extractedVendor extractedTotal mappedAccountCode mappedAccountName } } }`;
          const historyRes = await executeGraphQL(historyQuery, { userId });
          const pastDocs = (historyRes?.listDocumentRecords?.items || []).filter((d: any) => d.extractedVendor && d.extractedVendor.toLowerCase().includes(inv.vendorName.toLowerCase()));
          if (pastDocs.length > 0) {
            historicalContext = `\n${pastDocs.slice(0,3).map((d: any) => `- Amount: $${d.extractedTotal || 0} -> Mapped to: ${d.mappedAccountCode} (${d.mappedAccountName})`).join("\n")}`;
          }
        } catch (e) {}
      }

      // --- BEDROCK AGENT ---
      let finalCoaCode = "6350"; let finalCoaName = "Miscellaneous Expenses";
      try {
        const bedrockResponse = await bedrock.send(new ConverseCommand({
          modelId: 'us.amazon.nova-2-lite-v1:0',
          messages: [{ role: 'user', content: [{ text: `Vendor: ${inv.vendorName}\nItems: ${purchasedItemsStr}\nHistory: ${historicalContext}\nCOA: ${JSON.stringify(userCoaList)}\nTask: Format: {"code": "SELECTED_CODE", "name": "SELECTED_NAME"}` }] }]
        }));
        let resultText = bedrockResponse.output?.message?.content?.[0]?.text?.replace(/```json/gi, '').replace(/```/g, '').trim() || "{}";
        const agentDecision = JSON.parse(resultText);
        if (agentDecision.code && agentDecision.name) { finalCoaCode = agentDecision.code; finalCoaName = agentDecision.name; }
      } catch (e) {}

      // --- APPSYNC MUTATIONS ---
      const appSyncPayload = {
        userId, accountantId: userAccountantId, companyName: userCompanyName, companyTrn: userCompanyTrn,
        extractedVendor: inv.vendorName, extractedTotal: inv.total, extractedTax: inv.tax, extractedDate: invoiceDate, vendorTRN: inv.trn,
        isMathValid, aiConfidenceScore: inv.lowestConfidence, mappedAccountCode: finalCoaCode, mappedAccountName: finalCoaName,
        s3FinalUri: `s3://${bucket}/${key}`, status: "PENDING_CUSTOMER"
      };

      if (i === 0) {
        // UPDATE the first placeholder row created by the frontend
        await executeGraphQL(`
          mutation UpdateDocumentRecord($input: UpdateDocumentRecordInput!) { updateDocumentRecord(input: $input) { documentId } }
        `, { input: { documentId: documentId, ...appSyncPayload } });
      } else {
        // CREATE brand new rows for any additional consolidated invoices
        await executeGraphQL(`
          mutation CreateDocumentRecord($input: CreateDocumentRecordInput!) { createDocumentRecord(input: $input) { documentId } }
        `, { input: { documentId: `${documentId}-${i}`, recordType: "DOCUMENT", ...appSyncPayload } });
      }
    }
    
    return { success: true, documentId, status: "PENDING_CUSTOMER" };

  } catch (error) {
    console.error("Extraction workflow failed:", error);
    try {
      await executeGraphQL(`mutation UpdateDocumentRecord($input: UpdateDocumentRecordInput!) { updateDocumentRecord(input: $input) { documentId } }`, 
      { input: { userId, documentId, status: "PROCESSING_FAILED" } });
    } catch (e) {}
    throw error;
  }
};