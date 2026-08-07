import { type ClientSchema, a, defineData } from '@aws-amplify/backend';

const schema = a.schema({
  DocumentRecord: a
    .model({
      // Composite Primary Key mimic (PK & SK)
      userId: a.string().required(),
      documentId: a.string().required(),
      
      // Metadata and State Lifecycle
      docType: a.string(),
      // Statuses: PENDING_CUSTOMER, CUSTOMER_APPROVED_CLEAN, CUSTOMER_APPROVED_FLAGGED, ACCOUNTANT_REVIEW, FINALIZED
      status: a.string(), 
      
      // Storage References
      s3RawUri: a.string(),
      s3RedactedUri: a.string(),
      s3FinalUri: a.string(),
      
      // Extracted Data (Flat fields for easy DynamoDB querying)
      extractedVendor: a.string(),
      extractedTotal: a.float(),
      extractedTax: a.float(),
      extractedDate: a.date(),
      vendorTRN: a.string(), // Tax Registration Number
      
      // AI Confidence & Validation
      aiConfidenceScore: a.float(),
      isMathValid: a.boolean(), // Does Subtotal + Tax = Total?
      
      // Accounting & COA Mapping
      mappedAccountCode: a.string(), // e.g., "6260"
      mappedAccountName: a.string(), // e.g., "Fuel Expense"
      
      // Raw Payloads & Orchestration
      rawTextractData: a.json(),
      stepFunctionTaskToken: a.string(),
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