import { type ClientSchema, a, defineData } from '@aws-amplify/backend';

const schema = a.schema({
  DocumentRecord: a
    .model({
      // --- CORE IDENTIFIERS (Composite Primary Key) ---
      userId: a.string().required(),
      documentId: a.string().required(),
      
      // --- METADATA & LIFECYCLE ---
      recordType: a.string(), // e.g., "DOCUMENT" or "PROFILE"
      docType: a.string(),
      // Statuses: PENDING_CUSTOMER, CUSTOMER_APPROVED_CLEAN, CUSTOMER_APPROVED_FLAGGED, ACCOUNTANT_REVIEW, FINALIZED
      status: a.string(), 
      
      // --- STORAGE REFERENCES ---
      s3RawUri: a.string(),
      s3RedactedUri: a.string(),
      s3FinalUri: a.string(),
      
      // --- EXTRACTED DOCUMENT DATA ---
      extractedVendor: a.string(),
      extractedTotal: a.float(),
      extractedTax: a.float(),
      extractedDate: a.string(),
      vendorTRN: a.string(), // Tax Registration Number (Vendor)
      
      // --- AI CONFIDENCE & VALIDATION ---
      aiConfidenceScore: a.float(),
      isMathValid: a.boolean(), // Does Subtotal + Tax = Total?
      accountantNote: a.string(),
      // --- ACCOUNTING & COA MAPPING ---
      mappedAccountCode: a.string(), // e.g., "6260"
      mappedAccountName: a.string(), // e.g., "Fuel Expense"
      
      // --- ORCHESTRATION ---
      rawTextractData: a.json(),
      stepFunctionTaskToken: a.string(),

      // --- ⚙️ CONFIG & PROFILE SPECIFIC FIELDS (Single Table Design) ---
      companyName: a.string(),
      companyType: a.string(),    // e.g., "WLL", "LLC", "EST"
      companyAddress: a.string(),
      companyTrn: a.string(),     // Tax Registration Number (Customer's own business)
      chartOfAccounts: a.json(),  // Array of { code, name }
    })
    .identifier(['userId', 'documentId'])
    .secondaryIndexes((index) => [
      index('status').queryField('listByStatus'),
      index('mappedAccountCode').queryField('listByAccountCode')
    ])
    .authorization((allow) => [
      // Rule 1: The Customer (owner) has full CRUD access to their own records
      allow.ownerDefinedIn('userId'),
      
      // Rule 2: The Accountant (Admin group) can read and update ANY record in the table
      allow.groups(['Admin']).to(['read', 'update'])
    ]),
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: 'userPool',
  },
});