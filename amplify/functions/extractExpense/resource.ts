import { defineFunction } from '@aws-amplify/backend';

export const extractExpense = defineFunction({
  name: 'extractExpense',
  entry: './handler.ts',
  timeoutSeconds: 90, // Textract can take a few seconds
  runtime: 20,
  resourceGroupName: 'storage',
  environment: {
    // This will be automatically populated by Amplify Data if configured correctly
    // or you can inject it explicitly in backend.ts
  }
});