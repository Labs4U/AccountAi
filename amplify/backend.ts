import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource';
import { data } from './data/resource';
import { storage } from './storage/resource'; // 1. Import the new storage resource
import { classifyDocument } from './functions/classifyDocument/resource';
import { extractExpense } from './functions/extractExpense/resource'; // 1. Import new function
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import * as s3Notifications from 'aws-cdk-lib/aws-s3-notifications';
import * as s3 from 'aws-cdk-lib/aws-s3';

const backend = defineBackend({
  auth,
  data,
  storage, // 2. Register storage in the backend
  classifyDocument,
  extractExpense,
});

// 3. Grant the Lambda permission to invoke Bedrock models
backend.classifyDocument.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['bedrock:InvokeModel', 'bedrock:Converse'],
    resources: ['*'], 
  })
);

// 4. Retrieve the auto-provisioned S3 bucket from the storage definition
const documentBucket = backend.storage.resources.bucket;

// 3. Grant Textract Lambda permissions to read the S3 bucket and call Textract
backend.extractExpense.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: [
      's3:GetObject',
      'textract:AnalyzeExpense'
    ],
    resources: [
      documentBucket.bucketArn,
      `${documentBucket.bucketArn}/*`,
      '*' // Textract API needs global scope
    ],
  })
);

// 5. Dynamically grant the Lambda permission to read/write to this specific bucket
backend.classifyDocument.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: [
      's3:GetObject',
      's3:PutObject',
      's3:DeleteObject',
      's3:ListBucket',
    ],
    resources: [
      documentBucket.bucketArn,
      `${documentBucket.bucketArn}/*`,
    ],
  })
);

// 6. Tell S3 to trigger the classification Lambda whenever a file is uploaded
documentBucket.addEventNotification(
  s3.EventType.OBJECT_CREATED,
  new s3Notifications.LambdaDestination(backend.classifyDocument.resources.lambda)
);