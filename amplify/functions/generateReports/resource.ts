import { defineFunction } from '@aws-amplify/backend';

export const generateReports = defineFunction({
  name: 'generateReports',
  entry: './handler.ts',
  timeoutSeconds: 60,
  resourceGroupName: 'data',
  environment: {
    BUCKET_NAME: 'account-ai-bh',
  },
});