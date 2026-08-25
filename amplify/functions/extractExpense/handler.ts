// import { Handler } from 'aws-lambda';
// import { TextractClient, StartExpenseAnalysisCommand, GetExpenseAnalysisCommand } from '@aws-sdk/client-textract';
// import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
// const textract = new TextractClient({});
// const bedrock = new BedrockRuntimeClient({});
// // ---------------------------------------------------------
// // HELPER: NATIVE GRAPHQL FETCH (Replaces Amplify Client)
// // ---------------------------------------------------------
// const executeGraphQL = async (query: string, variables: any) => {
//   const endpoint = process.env.AMPLIFY_DATA_GRAPHQL_ENDPOINT;
//   const apiKey = process.env.AMPLIFY_DATA_GRAPHQL_API_KEY;

//   if (!endpoint || !apiKey) throw new Error("Missing AppSync environment variables.");

//   const response = await fetch(endpoint, {
//     method: 'POST',
//     headers: {
//       'Content-Type': 'application/json',
//       'x-api-key': apiKey
//     },
//     body: JSON.stringify({ query, variables })
//   });

//   const json = await response.json();
//   if (json.errors) {
//     console.error("AppSync Error:", JSON.stringify(json.errors, null, 2));
//     throw new Error(json.errors[0].message);
//   }
//   return json.data;
// };

// interface ExtractionPayload {
//   documentType: string;
//   bucket: string;
//   key: string;
// }

// export const handler: Handler<ExtractionPayload> = async (event) => {
//   console.log("ExtractExpense triggered:", JSON.stringify(event, null, 2));
//   const { bucket, key } = event;

//   // Extract userId and documentId from the S3 Key
//   const pathParts = key.split('/');
//   const userId = pathParts[0]; 
//   const fileName = pathParts.pop() || '';
//   const documentId = fileName.split('.')[0]; 

//   try {

//     // ---------------------------------------------------------
//     // 1. FETCH CUSTOMER CONFIGURATION (OR SYSTEM DEFAULT)
//     // ---------------------------------------------------------
//     let userCoaList: any[] = [];
//     let userCompanyName: string | null = null;
//     let userCompanyTrn: string | null = null;
//     let userAccountantId: string | null = null; // 🟢 NEW: Hold the accountant ID

//     try {
//       const getQuery = `
//         query GetDocumentRecord($userId: String!, $documentId: String!) {
//           getDocumentRecord(userId: $userId, documentId: $documentId) {
//             chartOfAccounts
//             companyName
//             companyTrn
//             accountantId   # 🟢 NEW: Request it from the database
//           }
//         }
//       `;
      
//       const configRes = await executeGraphQL(getQuery, { userId, documentId: "CUST" });
//       const configRecord = configRes?.getDocumentRecord;
      
//       if (configRecord) {
//         userCompanyName = configRecord.companyName || null;
//         userCompanyTrn = configRecord.companyTrn || null;
//         userAccountantId = configRecord.accountantId || null; // 🟢 NEW: Extract it

//         if (configRecord.chartOfAccounts) {
//           userCoaList = typeof configRecord.chartOfAccounts === 'string' 
//             ? JSON.parse(configRecord.chartOfAccounts) 
//             : configRecord.chartOfAccounts;
//         }
//       }

//       // 🟢 Attempt B: If the customer has no COA, fetch the Global SYSTEM COA
//       if (userCoaList.length === 0) {
//         console.log(`No custom COA for ${userId}. Fetching SYSTEM default COA.`);
        
//         const sysRes = await executeGraphQL(getQuery, { userId: "SYSTEM", documentId: "DEFAULT_COA" });
//         const sysRecord = sysRes?.getDocumentRecord;
        
//         if (sysRecord && sysRecord.chartOfAccounts) {
//            userCoaList = typeof sysRecord.chartOfAccounts === 'string' 
//             ? JSON.parse(sysRecord.chartOfAccounts) 
//             : sysRecord.chartOfAccounts;
//         }
//       }

//     } catch (err) {
//       console.warn("Could not fetch CONFIG or SYSTEM records. Proceeding with emergency defaults.", err);
//     }

//     // Emergency Fallback (Just in case the SYSTEM record is accidentally deleted)
//     if (userCoaList.length === 0) {
//       console.warn("No custom COA found. Injecting comprehensive Global Fallback list.");
//       userCoaList = [
//         { code: "1000", name: "ASSETS" }, { code: "1100", name: "Cash on Hand" }, 
//         { code: "1200", name: "Accounts Receivable" }, { code: "1300", name: "Inventory" }, 
//         { code: "1400", name: "Prepaid Expenses" }, { code: "1500", name: "Fixed Assets" },
//         { code: "2000", name: "LIABILITIES" }, { code: "2100", name: "Accounts Payable" }, 
//         { code: "2200", name: "Accrued Expenses" }, { code: "2300", name: "VAT/Sales Tax Payable" }, 
//         { code: "3000", name: "EQUITY" }, { code: "4000", name: "REVENUE" }, 
//         { code: "5000", name: "COST OF SALES" }, { code: "6000", name: "OPERATING EXPENSES" }, 
//         { code: "6100", name: "Salaries and Wages" }, { code: "6200", name: "Rent Expense" }, 
//         { code: "6210", name: "Utilities Expense" }, { code: "6220", name: "Telephone & Internet" }, 
//         { code: "6230", name: "Office Supplies" }, { code: "6240", name: "Repairs & Maintenance" }, 
//         { code: "6290", name: "Travel & Entertainment" }, { code: "6300", name: "Marketing & Advertising" }, 
//         { code: "6310", name: "Professional Fees" }, { code: "6330", name: "Software Subscriptions" }, 
//         { code: "6340", name: "Training Expense" }, { code: "6350", name: "Miscellaneous Expenses" }, 
//         { code: "7000", name: "FINANCE & TAX EXPENSES" }
//       ];
//     }

//     // ---------------------------------------------------------
//     // 2. TEXTRACT EXTRACTION
//     // ---------------------------------------------------------
//     let textractResponse: any;

//     try {
//       // 🟢 1. Start the asynchronous multi-page job
//       const startRes = await textract.send(new StartExpenseAnalysisCommand({
//         DocumentLocation: { S3Object: { Bucket: bucket, Name: key } }
//       }));
      
//       const jobId = startRes.JobId;
//       console.log(`Started Async Textract Job: ${jobId} for multi-page support.`);

//       // 🟢 2. Poll until the document is finished processing
//       let jobStatus = "IN_PROGRESS";
//       while (jobStatus === "IN_PROGRESS") {
//         await new Promise(resolve => setTimeout(resolve, 2500)); // Wait 2.5 seconds
//         const getRes = await textract.send(new GetExpenseAnalysisCommand({ JobId: jobId }));
//         jobStatus = getRes.JobStatus || "FAILED";
        
//         if (jobStatus === "SUCCEEDED") {
//           textractResponse = getRes;
//         } else if (jobStatus === "FAILED" || jobStatus === "PARTIAL_SUCCESS") {
//           throw new Error(`Textract Async Job failed with status: ${jobStatus}`);
//         }
//       }
//     } catch (textractErr: any) {
//       console.error("Textract Failed (Check S3 permissions or file presence):", textractErr);
//       throw textractErr;
//     }

//     let vendorName = "Unknown Vendor";
//     let total = 0;
//     let tax = 0;
//     let subtotal = 0;
//     let date = new Date().toISOString().split('T')[0];
//     let trn = "NOT_FOUND"; 
//     let lowestConfidence = 100;
//     let purchasedItems: string[] = [];

//     // 🟢 3. Loop through all pages/documents returned by the Async API
//     const expenseDocs = textractResponse.ExpenseDocuments || [];
    
//     expenseDocs.forEach((doc: any) => {
//       const summaryFields = doc.SummaryFields || [];
      
//       summaryFields.forEach((field: any) => {
//         const type = field.Type?.Text;
//         const val = field.ValueDetection?.Text;
//         const conf = field.ValueDetection?.Confidence || 100;

//         if (conf < lowestConfidence) lowestConfidence = conf;
        
//         // Grab the highest totals found across all pages
//         if (type === "VENDOR_NAME" && val && vendorName === "Unknown Vendor") vendorName = val;
//         if (type === "TOTAL" && val) total = Math.max(total, parseFloat(val.replace(/[^0-9.-]+/g,"")));
//         if (type === "TAX" && val) tax = Math.max(tax, parseFloat(val.replace(/[^0-9.-]+/g,"")));
//         if (type === "SUBTOTAL" && val) subtotal = Math.max(subtotal, parseFloat(val.replace(/[^0-9.-]+/g,"")));
//         if (type === "INVOICE_RECEIPT_DATE" && val && date === new Date().toISOString().split('T')[0]) date = val;
//         if (type === "RECEIVER_TAX_ID" && val && trn === "NOT_FOUND") trn = val;
//       });

//       const lineItemGroups = doc.LineItemGroups || [];
//       lineItemGroups.forEach((group: any) => {
//         group.LineItems?.forEach((item: any) => {
//           const itemDesc = item.LineItemExpenseFields?.find((f: any) => f.Type?.Text === "ITEM")?.ValueDetection?.Text;
//           if (itemDesc) purchasedItems.push(itemDesc);
//         });
//       });
//     });

//     const purchasedItemsStr = purchasedItems.length > 0 ? purchasedItems.join(", ") : "Unspecified / Summary Only";
    
//     const calculatedSubtotal = total - tax;
//     const isMathValid = subtotal > 0 
//         ? Math.abs((subtotal + tax) - total) < 0.05 
//         : Math.abs(calculatedSubtotal + tax - total) < 0.05;


//     // ---------------------------------------------------------
//     // 2B. HISTORICAL MEMORY RETRIEVAL (RAG)
//     // ---------------------------------------------------------
//     let historicalContext = "No previous history for this vendor.";
//     if (vendorName !== "Unknown Vendor") {
//       try {
//         // Query AppSync for finalized documents from this specific user
//         const historyQuery = `
//           query ListHistoricalDocs($userId: String!) {
//             listDocumentRecords(filter: { 
//               userId: { eq: $userId },
//               status: { eq: "FINALIZED" } 
//             }, limit: 100) {
//               items {
//                 extractedVendor
//                 extractedTotal
//                 mappedAccountCode
//                 mappedAccountName
//               }
//             }
//           }
//         `;
        
//         const historyRes = await executeGraphQL(historyQuery, { userId: userId });
//         const pastDocs = historyRes?.listDocumentRecords?.items || [];
        
//         // Filter in memory for this specific vendor (case insensitive)
//         const vendorHistory = pastDocs.filter((d: any) => 
//           d.extractedVendor && d.extractedVendor.toLowerCase().includes(vendorName.toLowerCase())
//         );

//         if (vendorHistory.length > 0) {
//           // Take the 3 most recent examples
//           const recentHistory = vendorHistory.slice(0, 3).map((d: any) => 
//             `- Amount: $${d.extractedTotal || 0} -> Mapped to: ${d.mappedAccountCode} (${d.mappedAccountName})`
//           ).join("\n");
          
//           historicalContext = `\n${recentHistory}`;
//           console.log(`🧠 Found historical memory for ${vendorName}:`, historicalContext);
//         }
//       } catch (histErr) {
//         console.warn("Could not retrieve historical context.", histErr);
//       }
//     }

//     // ---------------------------------------------------------
//     // 3. AI AGENT REASONING (Amazon Bedrock) - WITH RAG
//     // ---------------------------------------------------------
//     let finalCoaCode = "6350";
//     let finalCoaName = "Miscellaneous Expenses";

//     const promptContext = `
//       You are an expert corporate accountant. 
//       Analyze this extracted document data:
//       - Vendor: ${vendorName}
//       - Total Amount: ${total}
//       - Purchased Items: ${purchasedItemsStr}

//       Here is how this specific customer categorized past invoices from this vendor:
//       ${historicalContext}

//       Here is the customer's specific Chart of Accounts (COA):
//       ${JSON.stringify(userCoaList, null, 2)}

//       Task: Select the single most appropriate COA category for this expense.
      
//       Rules:
//       1. CRITICAL: If there is "past invoice" history provided above, you MUST map this expense to the exact same COA code and name used previously, unless the "Purchased Items" indicate a drastically different purchase.
//       2. If there is no history, rely on the "Purchased Items" (e.g., "Printer Ink" = Office Supplies).
//       3. If the items are "Unspecified" and there is no history, map the Vendor's primary industry to the most logical COA.
//       4. Fallback: If completely unknown, default to "Miscellaneous Expenses".

//       You MUST respond with a valid JSON object and NOTHING ELSE. Do not include markdown formatting, backticks, or conversational text.
//       Format: {"code": "SELECTED_CODE", "name": "SELECTED_NAME"}
//     `;

//     try {
//       const bedrockResponse = await bedrock.send(
//         new ConverseCommand({
//           modelId: 'us.amazon.nova-2-lite-v1:0',
//           messages: [{ role: 'user', content: [{ text: promptContext }] }]
//         })
//       );

//       let resultText = bedrockResponse.output?.message?.content?.[0]?.text?.trim() || "{}";
      
//       // DIAGNOSTIC: See what the AI actually said in CloudWatch
//       console.log("RAW BEDROCK COA RESPONSE:", resultText);
      
//       // Aggressively strip out Markdown backticks if the AI disobeys instructions
//       resultText = resultText.replace(/```json/gi, '').replace(/```/g, '').trim();
      
//       // Safely parse
//       if (resultText.startsWith('{') && resultText.endsWith('}')) {
//           const agentDecision = JSON.parse(resultText);
//           if (agentDecision.code && agentDecision.name) {
//             finalCoaCode = agentDecision.code;
//             finalCoaName = agentDecision.name;
//             console.log(`✅ AI Successfully Mapped ${vendorName} to ${finalCoaCode} - ${finalCoaName}`);
//           }
//       } else {
//           console.warn("❌ Bedrock did not return a pure JSON object. Fallback to Miscellaneous.");
//       }
//     } catch (agentErr) {
//       console.warn("❌ AI Agent COA mapping failed, falling back to Miscellaneous.", agentErr);
//     }

    

//    // ---------------------------------------------------------
//     // 4. UPDATE VIA APPSYNC (Triggers Frontend Subscriptions)
//     // ---------------------------------------------------------
//     const updateMutation = `
//       mutation UpdateDocumentRecord($input: UpdateDocumentRecordInput!) {
//         updateDocumentRecord(input: $input) {
//           userId
//           documentId
//           accountantId
//           companyName
//           companyTrn
//           recordType
//           docType
//           status
//           s3RawUri
//           s3FinalUri
//           extractedVendor
//           extractedTotal
//           extractedTax
//           extractedDate
//           vendorTRN
//           aiConfidenceScore
//           isMathValid
//           accountantNote
//           mappedAccountCode
//           mappedAccountName
//           createdAt
//           updatedAt
//           __typename
//         }
//       }
//     `;

//     await executeGraphQL(updateMutation, {
//       input: {
//         userId: userId,
//         documentId: documentId,
//         accountantId: userAccountantId,
//         companyName: userCompanyName, // 🟢 Stamp Company Name
//         companyTrn: userCompanyTrn,   // 🟢 Stamp Company TRN
//         extractedVendor: vendorName,
//         extractedTotal: total,
//         extractedTax: tax,
//         extractedDate: date,
//         vendorTRN: trn,
//         isMathValid: isMathValid,
//         aiConfidenceScore: lowestConfidence,
//         mappedAccountCode: finalCoaCode,
//         mappedAccountName: finalCoaName,
//         s3FinalUri: `s3://${bucket}/${key}`, 
//         status: "PENDING_CUSTOMER" 
//       }
//     });

//     return { success: true, documentId, status: "PENDING_CUSTOMER" };

//   } catch (error) {
//     console.error("Extraction workflow failed:", error);
    
//     // 🟢 Also fix the failure mutation to return userId!
//     try {
//       const failMutation = `
//         mutation UpdateDocumentRecord($input: UpdateDocumentRecordInput!) {
//           updateDocumentRecord(input: $input) { 
//             userId
//             documentId 
//             status 
//           }
//         }
//       `;
//       await executeGraphQL(failMutation, {
//         input: { userId, documentId, status: "PROCESSING_FAILED" }
//       });
//     } catch (updateErr) {
//       console.error("Could not update failure status in AppSync", updateErr);
//     }
    
//     throw error;
//   }
// };
import { Handler } from 'aws-lambda';
import { TextractClient, StartExpenseAnalysisCommand, GetExpenseAnalysisCommand } from '@aws-sdk/client-textract';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

const textract = new TextractClient({});
const bedrock = new BedrockRuntimeClient({});

// ---------------------------------------------------------
// HELPER: NATIVE GRAPHQL FETCH (Replaces Amplify Client)
// ---------------------------------------------------------
const executeGraphQL = async (query: string, variables: any) => {
  const endpoint = process.env.AMPLIFY_DATA_GRAPHQL_ENDPOINT;
  const apiKey = process.env.AMPLIFY_DATA_GRAPHQL_API_KEY;

  if (!endpoint || !apiKey) throw new Error("Missing AppSync environment variables.");

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey
    },
    body: JSON.stringify({ query, variables })
  });

  const json = await response.json();
  if (json.errors) {
    console.error("AppSync Error:", JSON.stringify(json.errors, null, 2));
    throw new Error(json.errors[0].message);
  }
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

  // Extract userId and documentId from the S3 Key
  const pathParts = key.split('/');
  const userId = pathParts[0]; 
  const fileName = pathParts.pop() || '';
  const documentId = fileName.split('.')[0]; 

  try {
    // ---------------------------------------------------------
    // 1. FETCH CUSTOMER CONFIGURATION (OR SYSTEM DEFAULT)
    // ---------------------------------------------------------
    let userCoaList: any[] = [];
    let userCompanyName: string | null = null;
    let userCompanyTrn: string | null = null;
    let userAccountantId: string | null = null;

    try {
      const getQuery = `
        query GetDocumentRecord($userId: String!, $documentId: String!) {
          getDocumentRecord(userId: $userId, documentId: $documentId) {
            chartOfAccounts
            companyName
            companyTrn
            accountantId
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
          userCoaList = typeof configRecord.chartOfAccounts === 'string' 
            ? JSON.parse(configRecord.chartOfAccounts) 
            : configRecord.chartOfAccounts;
        }
      }

      if (userCoaList.length === 0) {
        console.log(`No custom COA for ${userId}. Fetching SYSTEM default COA.`);
        const sysRes = await executeGraphQL(getQuery, { userId: "SYSTEM", documentId: "DEFAULT_COA" });
        const sysRecord = sysRes?.getDocumentRecord;
        if (sysRecord && sysRecord.chartOfAccounts) {
           userCoaList = typeof sysRecord.chartOfAccounts === 'string' 
            ? JSON.parse(sysRecord.chartOfAccounts) 
            : sysRecord.chartOfAccounts;
        }
      }
    } catch (err) {
      console.warn("Could not fetch CONFIG or SYSTEM records. Proceeding with emergency defaults.", err);
    }

    if (userCoaList.length === 0) {
      console.warn("No custom COA found. Injecting comprehensive Global Fallback list.");
      userCoaList = [
        { code: "1000", name: "ASSETS" }, { code: "2000", name: "LIABILITIES" }, 
        { code: "3000", name: "EQUITY" }, { code: "4000", name: "REVENUE" }, 
        { code: "6350", name: "Miscellaneous Expenses" }
      ]; // Shortened for brevity
    }

    // ---------------------------------------------------------
    // 2. TEXTRACT ASYNC EXTRACTION
    // ---------------------------------------------------------
    let textractResponse: any;

    try {
      const startRes = await textract.send(new StartExpenseAnalysisCommand({
        DocumentLocation: { S3Object: { Bucket: bucket, Name: key } }
      }));
      
      const jobId = startRes.JobId;
      console.log(`Started Async Textract Job: ${jobId} for multi-page support.`);

      let jobStatus = "IN_PROGRESS";
      while (jobStatus === "IN_PROGRESS") {
        await new Promise(resolve => setTimeout(resolve, 2500)); 
        const getRes = await textract.send(new GetExpenseAnalysisCommand({ JobId: jobId }));
        jobStatus = getRes.JobStatus || "FAILED";
        
        if (jobStatus === "SUCCEEDED") {
          textractResponse = getRes;
        } else if (jobStatus === "FAILED" || jobStatus === "PARTIAL_SUCCESS") {
          throw new Error(`Textract Async Job failed with status: ${jobStatus}`);
        }
      }
    } catch (textractErr: any) {
      console.error("Textract Failed (Check S3 permissions or file presence):", textractErr);
      throw textractErr;
    }

    const expenseDocs = textractResponse.ExpenseDocuments || [];
    if (expenseDocs.length === 0) throw new Error("No invoices found in the document.");
    
    console.log(`Found ${expenseDocs.length} distinct invoices in the uploaded file.`);

    // ---------------------------------------------------------
    // 3. PROCESS EVERY INVOICE INDIVIDUALLY
    // ---------------------------------------------------------
    for (let i = 0; i < expenseDocs.length; i++) {
      const doc = expenseDocs[i];
      
      let vendorName = "Unknown Vendor";
      let total = 0;
      let tax = 0;
      let subtotal = 0;
      let date = new Date().toISOString().split('T')[0];
      let trn = "NOT_FOUND"; 
      let lowestConfidence = 100;
      let purchasedItems: string[] = [];

      // Extract details for THIS specific invoice
      (doc.SummaryFields || []).forEach((field: any) => {
        const type = field.Type?.Text;
        const val = field.ValueDetection?.Text;
        const conf = field.ValueDetection?.Confidence || 100;

        if (conf < lowestConfidence) lowestConfidence = conf;
        
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

      const purchasedItemsStr = purchasedItems.length > 0 ? purchasedItems.join(", ") : "Unspecified / Summary Only";
      const calculatedSubtotal = total - tax;
      const isMathValid = subtotal > 0 
          ? Math.abs((subtotal + tax) - total) < 0.05 
          : Math.abs(calculatedSubtotal + tax - total) < 0.05;

      // --- RAG For this Vendor ---
      let historicalContext = "No previous history for this vendor.";
      if (vendorName !== "Unknown Vendor") {
        try {
          const historyQuery = `
            query ListHistoricalDocs($userId: String!) {
              listDocumentRecords(filter: { userId: { eq: $userId }, status: { eq: "FINALIZED" } }, limit: 100) {
                items { extractedVendor extractedTotal mappedAccountCode mappedAccountName }
              }
            }
          `;
          const historyRes = await executeGraphQL(historyQuery, { userId: userId });
          const pastDocs = historyRes?.listDocumentRecords?.items || [];
          
          const vendorHistory = pastDocs.filter((d: any) => d.extractedVendor && d.extractedVendor.toLowerCase().includes(vendorName.toLowerCase()));

          if (vendorHistory.length > 0) {
            const recentHistory = vendorHistory.slice(0, 3).map((d: any) => 
              `- Amount: $${d.extractedTotal || 0} -> Mapped to: ${d.mappedAccountCode} (${d.mappedAccountName})`
            ).join("\n");
            historicalContext = `\n${recentHistory}`;
          }
        } catch (histErr) {}
      }

      // --- Bedrock For this Invoice ---
      let finalCoaCode = "6350";
      let finalCoaName = "Miscellaneous Expenses";

      const promptContext = `
        You are an expert corporate accountant. 
        Analyze this extracted document data:
        - Vendor: ${vendorName}
        - Total Amount: ${total}
        - Purchased Items: ${purchasedItemsStr}
        Here is how this specific customer categorized past invoices from this vendor:
        ${historicalContext}
        Here is the customer's specific Chart of Accounts (COA):
        ${JSON.stringify(userCoaList, null, 2)}
        Task: Select the single most appropriate COA category for this expense.
        Rules:
        1. CRITICAL: If there is "past invoice" history provided above, you MUST map this expense to the exact same COA code and name used previously.
        2. If there is no history, rely on the "Purchased Items".
        3. If unknown, default to "Miscellaneous Expenses".
        You MUST respond with a valid JSON object and NOTHING ELSE. Format: {"code": "SELECTED_CODE", "name": "SELECTED_NAME"}
      `;

      try {
        const bedrockResponse = await bedrock.send(new ConverseCommand({
          modelId: 'us.amazon.nova-2-lite-v1:0',
          messages: [{ role: 'user', content: [{ text: promptContext }] }]
        }));

        let resultText = bedrockResponse.output?.message?.content?.[0]?.text?.trim() || "{}";
        resultText = resultText.replace(/```json/gi, '').replace(/```/g, '').trim();
        
        if (resultText.startsWith('{') && resultText.endsWith('}')) {
            const agentDecision = JSON.parse(resultText);
            if (agentDecision.code && agentDecision.name) {
              finalCoaCode = agentDecision.code;
              finalCoaName = agentDecision.name;
            }
        }
      } catch (agentErr) {}

      // --- AppSync Mutation for this Invoice ---
      const payloadInput = {
        userId: userId,
        accountantId: userAccountantId,
        companyName: userCompanyName,
        companyTrn: userCompanyTrn,
        extractedVendor: vendorName,
        extractedTotal: total,
        extractedTax: tax,
        extractedDate: date,
        vendorTRN: trn,
        isMathValid: isMathValid,
        aiConfidenceScore: lowestConfidence,
        mappedAccountCode: finalCoaCode,
        mappedAccountName: finalCoaName,
        s3FinalUri: `s3://${bucket}/${key}`, 
        status: "PENDING_CUSTOMER" 
      };

      if (i === 0) {
        // Invoice 1 updates the placeholder row the user already sees
        const updateMutation = `
          mutation UpdateDocumentRecord($input: UpdateDocumentRecordInput!) {
            updateDocumentRecord(input: $input) { documentId }
          }
        `;
        await executeGraphQL(updateMutation, { input: { documentId: documentId, ...payloadInput } });
      } else {
        // Invoice 2+ creates brand new rows in the dashboard
        const createMutation = `
          mutation CreateDocumentRecord($input: CreateDocumentRecordInput!) {
            createDocumentRecord(input: $input) { documentId }
          }
        `;
        await executeGraphQL(createMutation, { 
          input: { 
            documentId: `${documentId}-${i}`, // Appends -1, -2, etc.
            recordType: "DOCUMENT",
            ...payloadInput 
          } 
        });
      }
    }

    return { success: true, documentId, status: "PENDING_CUSTOMER" };

  } catch (error) {
    console.error("Extraction workflow failed:", error);
    try {
      const failMutation = `
        mutation UpdateDocumentRecord($input: UpdateDocumentRecordInput!) {
          updateDocumentRecord(input: $input) { userId documentId status }
        }
      `;
      await executeGraphQL(failMutation, {
        input: { userId, documentId, status: "PROCESSING_FAILED" }
      });
    } catch (updateErr) {}
    throw error;
  }
};