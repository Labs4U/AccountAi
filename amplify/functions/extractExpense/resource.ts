import { defineFunction } from '@aws-amplify/backend';

export const extractExpense = defineFunction({
  name: 'extractExpense',
  entry: './handler.ts',
  timeoutSeconds: 60, // Textract can take a few seconds
  runtime: 20,
  resourceGroupName: 'storage'
});