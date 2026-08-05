import { defineFunction } from '@aws-amplify/backend';

export const classifyDocument = defineFunction({
  name: 'classifyDocument',
  entry: './handler.ts',
  environment: {
    MODEL_ID: 'us.amazon.nova-2-lite-v1:0',
  },
  timeoutSeconds: 30,
  runtime: 20,
  resourceGroupName: 'storage'
});