import { type ClientSchema, a, defineData } from '@aws-amplify/backend';
import { generateReports } from '../functions/generateReports/resource'; // 🟢 Added import for the Lambda

const schema = a.schema({
  DocumentRecord: a
    .model({
      // --- CORE IDENTIFIERS (Composite Primary Key) ---
      userId: a.string().required(),
      documentId: a.string().required(),
      accountantId: a.string(),
   
      // --- METADATA & LIFECYCLE ---
      recordType: a.string(),
      docType: a.string(),
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
      vendorTRN: a.string(),
      
      // --- AI CONFIDENCE & VALIDATION ---
      aiConfidenceScore: a.float(),
      isMathValid: a.boolean(),
      accountantNote: a.string(),

      // --- ACCOUNTING & COA MAPPING ---
      mappedAccountCode: a.string(),
      mappedAccountName: a.string(),
      
      // --- ORCHESTRATION ---
      rawTextractData: a.json(),
      stepFunctionTaskToken: a.string(),

      // --- ⚙️ CONFIG & PROFILE SPECIFIC FIELDS ---
      companyName: a.string(),
      companyType: a.string(),    
      companyAddress: a.string(),
      companyTrn: a.string(),     
      chartOfAccounts: a.json(),
      
      // --- 👤 ACCOUNTANT PROFILE FIELDS ---
      name: a.string(),
      firmName: a.string(),
      address: a.string(),
      contactEmail: a.string(),  
    })
    .identifier(['userId', 'documentId'])
    .secondaryIndexes((index) => [
      index('status').queryField('listByStatus'),
      index('mappedAccountCode').queryField('listByAccountCode'),
      
      // 🟢 NEW: Allows Customers to fetch all Accountant profiles without scanning the whole table
      index('documentId').queryField('listByDocumentId'),
      
      // 🟢 NEW: Allows Accountants to instantly fetch their assigned documents, optionally sorted by status
      index('accountantId').sortKeys(['status']).queryField('listByAccountantAndStatus')
    ])
    .authorization((allow) => [
      // Rule 1: The Customer has full CRUD access to their own records
      allow.ownerDefinedIn('userId'),
      
      // Rule 2: The Accountant can read and update ANY record in the table
      allow.groups(['Admin']).to(['create', 'read', 'update', 'delete']),
      
      // Rule 3: API Key has full CRUD (for Lambda via API Key auth)
      allow.publicApiKey().to(['create', 'read', 'update', 'delete']),
      
      // Rule 4: Authenticated users via Identity Pool (IAM) have full access (for Lambda execution role)
      allow.authenticated('identityPool').to(['create', 'read', 'update', 'delete'])
    ]),

  // 🟢 NEW: Custom Mutation to trigger the Report Lambda manually
  triggerReportsManual: a
    .mutation()
    .returns(a.json())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(generateReports)),
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: 'userPool',
    apiKeyAuthorizationMode: {
      expiresInDays: 365 
    }
  },
});