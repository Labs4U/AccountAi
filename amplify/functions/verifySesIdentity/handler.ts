import type { PostConfirmationTriggerHandler } from 'aws-lambda';
import { SESClient, VerifyEmailIdentityCommand } from '@aws-sdk/client-ses';

const ses = new SESClient({});

/**
 * Cognito Post-Confirmation trigger.
 *
 * Fires after a user successfully confirms their account (email code or admin
 * confirmation). Calls SES VerifyEmailIdentity so our SES Sandbox account can
 * send automated compliance alerts to this address.
 *
 * The trigger must return the original event unchanged — Cognito rejects any
 * modified event object and will block the confirmation flow.
 */
export const handler: PostConfirmationTriggerHandler = async (event) => {
  const email = event.request.userAttributes?.email;

  if (!email) {
    console.warn('verifySesIdentity: no email attribute on event, skipping.', {
      userPoolId: event.userPoolId,
      userName: event.userName,
    });
    return event;
  }

  try {
    await ses.send(new VerifyEmailIdentityCommand({ EmailAddress: email }));
    console.log(`verifySesIdentity: verification email sent to ${email}`);
  } catch (err) {
    // Log but never throw — a failed SES call must not block user sign-up.
    console.error(`verifySesIdentity: SES call failed for ${email}`, err);
  }

  return event;
};
