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

// 🟢 NEW HELPER: BULLETPROOF UPSERT
// Safely handles DynamoDB ConditionalCheckFailedExceptions due to race conditions or retries
const safeUpsertRecord = async (payload: any, attemptCreateFirst: boolean) => {
  const createQuery = `mutation CreateDocumentRecord($input: CreateDocumentRecordInput!) { createDocumentRecord(input: $input) { documentId } }`;
  const updateQuery = `mutation UpdateDocumentRecord($input: UpdateDocumentRecordInput!) { updateDocumentRecord(input: $input) { documentId } }`;
  
  try {
    if (attemptCreateFirst) {
      await executeGraphQL(createQuery, { input: { recordType: "DOCUMENT", ...payload } });
    } else {
      await executeGraphQL(updateQuery, { input: payload });
    }
  } catch (error: any) {
    if (error.message && (error.message.includes("ConditionalCheckFailed") || error.message.includes("conditional request failed"))) {
      console.log(`Swap fallback triggered for ${payload.documentId}.`);
      if (attemptCreateFirst) {
        await executeGraphQL(updateQuery, { input: payload });
      } else {
        await executeGraphQL(createQuery, { input: { recordType: "DOCUMENT", ...payload } });
      }
    } else {
      throw error;
    }
  }
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
    // 2.5 CONSOLIDATE MULTI-PAGE INVOICES 
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

      if (pageInvoiceId) {
        currentInvoiceId = pageInvoiceId;
      } else if (index === 0) {
        currentInvoiceId = `unknown_${unknownCounter++}`;
      }

      if (!consolidatedInvoices[currentInvoiceId]) {
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

      // 🟢 REPLACE EVERYTHING BELOW THIS LINE INSIDE THE LOOP 🟢

      // --- BEDROCK AGENT ---
      let finalCoaCode = "6350"; 
      let finalCoaName = "Miscellaneous Expenses";
      let finalDocType = "INVOICE"; // Default fallback

      const promptContext = `
        You are an expert corporate accountant. 
        Analyze this extracted document data:
        - Vendor: ${inv.vendorName}
        - Total Amount: ${inv.total}
        - Purchased Items: ${purchasedItemsStr}
        
        Here is how this specific customer categorized past invoices from this vendor:
        ${historicalContext}
        
        Here is the customer's STRICT Chart of Accounts (COA):
        ${JSON.stringify(userCoaList, null, 2)}
        
        Tasks:
        1. Select the single most appropriate COA category for this expense STRICTLY from the provided list. Do not invent categories.
        2. Classify if the document is an "INVOICE" (a formal bill requesting payment) or a "RECEIPT" (a point-of-sale slip indicating payment was already made).
        
        Rules:
        1. CRITICAL: If there is "past invoice" history provided above, you MUST map this expense to the exact same COA code and name used previously.
        2. If there is no history, rely on the "Purchased Items" and the Vendor's primary industry. 
        3. If completely unknown, default to "Miscellaneous Expenses".
        
        You MUST respond with a valid JSON object and NOTHING ELSE. 
        Format: {"code": "SELECTED_CODE", "name": "SELECTED_NAME", "docType": "INVOICE" | "RECEIPT"}
      `;

      try {
        const bedrockResponse = await bedrock.send(new ConverseCommand({
          modelId: 'us.amazon.nova-2-lite-v1:0',
          messages: [{ role: 'user', content: [{ text: promptContext }] }]
        }));
        
        let resultText = bedrockResponse.output?.message?.content?.[0]?.text?.replace(/```json/gi, '').replace(/```/g, '').trim() || "{}";
        const agentDecision = JSON.parse(resultText);
        
        if (agentDecision.code && agentDecision.name) { 
          finalCoaCode = agentDecision.code; 
          finalCoaName = agentDecision.name; 
        }
        if (agentDecision.docType) {
          finalDocType = agentDecision.docType; // Capture the classification
        }
      } catch (e) {
        console.warn("Bedrock AI failed to parse, using defaults.", e);
      }

      // --- 🟢 APPSYNC SAFE UPSERT ---
      const appSyncPayload = {
        userId, 
        documentId: i === 0 ? documentId : `${documentId}-${i}`, // Attach ID safely
        accountantId: userAccountantId, 
        companyName: userCompanyName, 
        companyTrn: userCompanyTrn,
        extractedVendor: inv.vendorName, 
        extractedTotal: inv.total, 
        extractedTax: inv.tax, 
        extractedDate: invoiceDate, 
        vendorTRN: inv.trn,
        isMathValid, 
        aiConfidenceScore: inv.lowestConfidence, 
        mappedAccountCode: finalCoaCode, 
        mappedAccountName: finalCoaName,
        docType: finalDocType, // 🟢 Saves "INVOICE" or "RECEIPT"
        s3FinalUri: `s3://${bucket}/${key}`, 
        status: "PENDING_CUSTOMER"
      };

      // For invoice 0, attempt Update first. For 1+, attempt Create first.
      await safeUpsertRecord(appSyncPayload, i > 0);
    }
    
    return { success: true, documentId, status: "PENDING_CUSTOMER" };

  } catch (error) {
    console.error("Extraction workflow failed:", error);
    // Apply bulletproof upsert to the failure catch block too!
    try {
      await safeUpsertRecord({ userId, documentId, status: "PROCESSING_FAILED" }, false);
    } catch (e) {}
    throw error;
  }
};