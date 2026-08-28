import type { PostConfirmationTriggerHandler } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

export const handler: PostConfirmationTriggerHandler = async (event) => {
  const email = event.request.userAttributes?.email;
  const sub = event.request.userAttributes?.sub;
  const tableName = process.env.DYNAMODB_TABLE_NAME;

  if (!email || !sub || !tableName) return event;

  try {
    await docClient.send(new UpdateCommand({
      TableName: tableName,
      Key: { userId: sub, documentId: "CUST" },
      UpdateExpression: "SET contactEmail = :email, recordType = if_not_exists(recordType, :rt)",
      ExpressionAttributeValues: { ":email": email, ":rt": "PROFILE_CUST" }
    }));
  } catch (err) {
    console.error(`DynamoDB synchronization failed for ${sub}`, err);
  }

  return event;
};