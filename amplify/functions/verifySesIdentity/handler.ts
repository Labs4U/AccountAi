import type { PostConfirmationTriggerHandler } from 'aws-lambda';
import { DynamoDBClient, ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

let cachedTableName: string | undefined;

async function resolveTableName(): Promise<string | undefined> {
  if (cachedTableName) return cachedTableName;
  try {
    const res = await ddbClient.send(new ListTablesCommand({}));
    const match = res.TableNames?.find((name) => name.startsWith('DocumentRecord-'));
    if (match) {
      cachedTableName = match;
    }
  } catch (err) {
    console.error('Failed to list DynamoDB tables:', err);
  }
  return cachedTableName;
}

export const handler: PostConfirmationTriggerHandler = async (event) => {
  const email = event.request.userAttributes?.email;
  const sub = event.request.userAttributes?.sub;

  if (!email || !sub) {
    console.warn('PostConfirmation: missing email or sub attribute, skipping.');
    return event;
  }

  // Synchronize Email to DynamoDB Profile Record
  const tableName = await resolveTableName();
  if (tableName) {
    try {
      await docClient.send(
        new UpdateCommand({
          TableName: tableName,
          Key: {
            userId: sub,
            documentId: 'CUST',
          },
          UpdateExpression: 'SET contactEmail = :email, recordType = if_not_exists(recordType, :rt)',
          ExpressionAttributeValues: {
            ':email': email,
            ':rt': 'PROFILE_CUST',
          },
        })
      );
      console.log(`Successfully mapped contactEmail to ${tableName} for User: ${sub}`);
    } catch (err) {
      console.error(`DynamoDB synchronization failed for ${sub}`, err);
    }
  } else {
    console.error('Could not resolve DocumentRecord table name from DynamoDB.');
  }

  return event;
};