import { type ClientSchema, a, defineData } from '@aws-amplify/backend';
import { generateReports } from '../functions/generateReports/resource'; // 🟢 Added import for the Lambda

const schema = a.schema({
  DocumentRecord: a
    .model({
      // --- CORE IDENTIFIERS (Composite Primary Key) ---
      userId: a.string().required(),
      documentId: a.string().required(),
   
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
    })
    .identifier(['userId', 'documentId'])
    .secondaryIndexes((index) => [
      index('status').queryField('listByStatus'),
      index('mappedAccountCode').queryField('listByAccountCode')
    ])
    .authorization((allow) => [
      // Rule 1: The Customer has full CRUD access to their own records
      allow.ownerDefinedIn('userId'),
      
      // Rule 2: The Accountant can read and update ANY record in the table
      allow.groups(['Admin']).to(['read', 'update']),
      allow.publicApiKey().to(['read', 'update'])
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