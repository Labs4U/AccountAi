import { defineFunction } from '@aws-amplify/backend';

export const verifySesIdentity = defineFunction({
  name: 'verifySesIdentity',
  entry: './handler.ts',
  runtime: 20,
  resourceGroupName: 'auth',
});
