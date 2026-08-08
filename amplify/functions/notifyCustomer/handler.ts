import { DynamoDBStreamHandler } from 'aws-lambda';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { CognitoIdentityProviderClient, AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider';

const sesClient = new SESClient({});
const cognitoClient = new CognitoIdentityProviderClient({});

export const handler: DynamoDBStreamHandler = async (event) => {
  console.log(`Received ${event.Records.length} stream records.`);

  const userPoolId = process.env.USER_POOL_ID;
  const senderEmail = process.env.SENDER_EMAIL; // e.g., no-reply@yourdomain.com

  if (!userPoolId || !senderEmail) {
    throw new Error("Missing required environment variables.");
  }

  for (const record of event.Records) {
    // 1. We only care about records that were UPDATED
    if (record.eventName !== 'MODIFY' || !record.dynamodb?.NewImage || !record.dynamodb?.OldImage) {
      continue;
    }

    const newImage = record.dynamodb.NewImage;
    const oldImage = record.dynamodb.OldImage;

    // 2. Check if the status JUST changed to PENDING_CUSTOMER
    const oldStatus = oldImage.status?.S;
    const newStatus = newImage.status?.S;
    const isReturningToCustomer = newStatus === 'PENDING_CUSTOMER' && oldStatus !== 'PENDING_CUSTOMER';

    if (isReturningToCustomer) {
      const documentId = newImage.documentId?.S || 'Unknown Document';
      const userId = newImage.userId?.S;
      const note = newImage.accountantNote?.S || 'Please review your document.';

      if (!userId) continue;

      try {
        // 3. Fetch the customer's email from Cognito using their userId (SUB)
        const cognitoUser = await cognitoClient.send(new AdminGetUserCommand({
          UserPoolId: userPoolId,
          Username: userId
        }));

        const emailAttr = cognitoUser.UserAttributes?.find(attr => attr.Name === 'email');
        const customerEmail = emailAttr?.Value;

        if (!customerEmail) {
          console.warn(`No email found for user ${userId}`);
          continue;
        }

        // 4. Construct a professional, safe HTML Template
        const htmlBody = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
            <h2 style="color: #334155;">Action Required: Document Review</h2>
            <p style="color: #475569; font-size: 16px;">Hello,</p>
            <p style="color: #475569; font-size: 16px;">Your accountant requires additional information to finalize a recent document submission.</p>
            
            <div style="background-color: #f8fafc; padding: 15px; border-left: 4px solid #f59e0b; margin: 20px 0;">
              <p style="margin: 0; color: #334155;"><strong>Document ID:</strong> ${documentId}</p>
              <p style="margin: 10px 0 0 0; color: #334155;"><strong>Accountant's Note:</strong></p>
              <p style="margin: 5px 0 0 0; color: #b45309; font-style: italic;">"${note}"</p>
            </div>

            <p style="color: #475569; font-size: 16px;">Please log into your portal to update the required information and re-approve the document.</p>
            <br/>
            <p style="color: #94a3b8; font-size: 12px;">This is an automated message from the AccountAI Compliance Platform.</p>
          </div>
        `;

        // 5. Dispatch the email via Amazon SES
        await sesClient.send(new SendEmailCommand({
          Source: senderEmail,
          Destination: { ToAddresses: [customerEmail] },
          Message: {
            Subject: { Data: `Action Required: Update needed for Document ${documentId}` },
            Body: { Html: { Data: htmlBody } }
          }
        }));

        console.log(`Successfully sent rejection notification to ${customerEmail} for ${documentId}`);

      } catch (error) {
        console.error(`Failed to process notification for ${documentId}:`, error);
      }
    }
  }
};