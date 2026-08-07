import { defineAuth } from '@aws-amplify/backend';

/**
 * Define and configure your auth resource
 * @see https://docs.amplify.aws/gen2/build-a-backend/auth
 */
export const auth = defineAuth({
  loginWith: {
    email: true,
  },
  // Automatically provision IAM Roles and Cognito User Groups for Role-Based Access Control (RBAC)
  groups: ["Admin", "Customer"],
});
