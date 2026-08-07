import { defineStorage } from '@aws-amplify/backend';

export const storage = defineStorage({
  name: 'accountAiDocumentsBucket',
  access: (allow) => ({
    // Broaden the path to allow Cognito SUB-based folders
    'private/*': [
      allow.authenticated.to(['read', 'write', 'delete']),
      allow.groups(['Customer', 'Admin']).to(['read', 'write', 'delete']),
    ],
  }),
});