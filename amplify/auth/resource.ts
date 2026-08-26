import { defineAuth } from '@aws-amplify/backend';
import { verifySesIdentity } from '../functions/verifySesIdentity/resource';

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
  triggers: {
    // Fires after a user successfully confirms their Cognito account.
    // Sends a SES verification email so automated compliance alerts can be delivered.
    postConfirmation: verifySesIdentity,
  },
});
