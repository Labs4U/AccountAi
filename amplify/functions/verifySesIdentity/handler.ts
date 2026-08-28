import type { PostConfirmationTriggerHandler } from 'aws-lambda';
import { SESClient, VerifyEmailIdentityCommand } from '@aws-sdk/client-ses';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const ses = new SESClient({});
const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

export const handler: PostConfirmationTriggerHandler = async (event) => {
  const email = event.request.userAttributes?.email;
  const sub = event.request.userAttributes?.sub; // The unique Cognito User ID
  const tableName = process.env.DYNAMODB_TABLE_NAME;

  if (!email || !sub) {
    console.warn('verifySesIdentity: missing email or sub attribute, skipping.');
    return event;
  }

  // 1. SES Sandbox Verification (Will fail silently in production, which is safe)
  try {
    await ses.send(new VerifyEmailIdentityCommand({ EmailAddress: email }));
    console.log(`SES verification sent to ${email}`);
  } catch (err) {
    console.error(`SES call failed for ${email}`, err);
  }

  // 2. Synchronize Email to DynamoDB Profile Record
  if (tableName) {
    try {
      await docClient.send(new UpdateCommand({
        TableName: tableName,
        Key: {
          userId: sub,
          documentId: "CUST" // Maps to the QuickSteps 'CUST' architecture
        },
        UpdateExpression: "SET contactEmail = :email, recordType = if_not_exists(recordType, :rt)",
        ExpressionAttributeValues: {
          ":email": email,
          ":rt": "PROFILE_CUST"
        }
      }));
      console.log(`Successfully mapped contactEmail to DynamoDB for User: ${sub}`);
    } catch (err) {
      console.error(`DynamoDB synchronization failed for ${sub}`, err);
    }
  }

  return event;
};