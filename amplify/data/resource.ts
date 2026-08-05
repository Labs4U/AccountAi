import { type ClientSchema, a, defineData } from '@aws-amplify/backend';

const schema = a.schema({
  DocumentRecord: a
    .model({
      // Composite Primary Key mimic (PK & SK)
      userId: a.string().required(),
      documentId: a.string().required(),
      
      // Metadata and State
      docType: a.string(),
      status: a.string(),
      
      // Storage References
      s3RawUri: a.string(),
      s3RedactedUri: a.string(),
      
      // Document Payloads
      extractedData: a.json(),
      stepFunctionTaskToken: a.string(),
    })
    // 1. Define the custom composite key
    .identifier(['userId', 'documentId'])
    
    // 2. Index by status to allow the frontend to quickly fetch pending tasks
    .secondaryIndexes((index) => [
      index('status').queryField('listByStatus')
    ])
    
    // 3. Strict owner authorization tied to the Cognito SUB (userId)
    .authorization((allow) => [
      allow.ownerDefinedIn('userId')
    ]),
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    // Default to Cognito User Pools since the app requires authentication
    defaultAuthorizationMode: 'userPool',
  },
});