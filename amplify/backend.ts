import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource';
import { data } from './data/resource';
import { classifyDocument } from './functions/classifyDocument/resource';
import { extractExpense } from './functions/extractExpense/resource';
import { generateReports } from './functions/generateReports/resource';

import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs'; 
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Duration } from 'aws-cdk-lib';

// 1. Remove 'storage' from the backend definition
const backend = defineBackend({
  auth,
  data,
  classifyDocument,
  extractExpense,
  generateReports
});

const workflowStack = backend.createStack('DocumentProcessingWorkflow');

// =======================================================================
// 1. WORKFLOW TASKS DEFINITION
// =======================================================================
const initProcessingTask = new sfn.Pass(workflowStack, 'InitProcessing_SetState', {
  parameters: {
    'input.$': '$',
    'status': 'PROCESSING',
    'timestamp.$': '$$.Execution.StartTime'
  },
  resultPath: '$.ingestResult'
});

const classifyTask = new tasks.LambdaInvoke(workflowStack, 'ClassifyDocumentTask', {
  lambdaFunction: backend.classifyDocument.resources.lambda,
  payload: sfn.TaskInput.fromJsonPathAt('$'),
  resultPath: '$.classificationResult',
  outputPath: '$',
});

const extractExpenseTask = new tasks.LambdaInvoke(workflowStack, 'ExtractExpense_Textract', {
  lambdaFunction: backend.extractExpense.resources.lambda,
  payload: sfn.TaskInput.fromObject({
    documentType: sfn.JsonPath.stringAt('$.classificationResult.Payload.documentType'),
    bucket: sfn.JsonPath.stringAt('$.classificationResult.Payload.bucket'),
    key: sfn.JsonPath.stringAt('$.classificationResult.Payload.key')
  }),
  resultPath: '$.extractionRawResult',
});

const ignoreTask = new sfn.Pass(workflowStack, 'IgnoreUnsupportedDocType', {
  result: sfn.Result.fromObject({ status: 'SKIPPED', reason: 'Unsupported document category' }),
});

const routingChoice = new sfn.Choice(workflowStack, 'RouteByDocumentType')
  .when(
    sfn.Condition.or(
      sfn.Condition.stringEquals('$.classificationResult.Payload.documentType', 'RECEIPT'),
      sfn.Condition.stringEquals('$.classificationResult.Payload.documentType', 'INVOICE')
    ),
    extractExpenseTask
  )
  .otherwise(ignoreTask);

const definition = initProcessingTask.next(classifyTask).next(routingChoice);

const stateMachine = new sfn.StateMachine(workflowStack, 'DocProcessingStateMachine', {
  definitionBody: sfn.DefinitionBody.fromChainable(definition),
  stateMachineType: sfn.StateMachineType.STANDARD, 
  timeout: Duration.minutes(5),
});

// =======================================================================
// 2. CONNECT TO EXISTING S3 BUCKET & EVENTBRIDGE
// =======================================================================
const existingBucket = s3.Bucket.fromBucketName(workflowStack, 'AccountAiBucket', 'account-ai-bh');

const s3UploadRule = new events.Rule(workflowStack, 'S3UploadRule', {
  eventPattern: {
    source: ['aws.s3'],
    detailType: ['Object Created'],
    detail: {
      bucket: { name: [existingBucket.bucketName] },
      object: {
        key: [{ wildcard: "*/raw/*" }] // Restored to watch the Inbox
      }
    }
  }
});

s3UploadRule.addTarget(new targets.SfnStateMachine(stateMachine));

// =======================================================================
// 3. IAM & BUCKET PERMISSIONS
// =======================================================================
existingBucket.grantReadWrite(backend.classifyDocument.resources.lambda);
existingBucket.grantReadWrite(backend.extractExpense.resources.lambda);

const userS3Policy = new iam.PolicyStatement({
  actions: ['s3:PutObject', 's3:GetObject', 's3:DeleteObject', 's3:ListBucket'],
  resources: [
    'arn:aws:s3:::account-ai-bh/*', 
    'arn:aws:s3:::account-ai-bh'    
  ]
});
backend.auth.resources.authenticatedUserIamRole.addToPrincipalPolicy(userS3Policy);
if (backend.auth.resources.groups) {
  backend.auth.resources.groups['Customer'].role.addToPrincipalPolicy(userS3Policy);
  backend.auth.resources.groups['Admin'].role.addToPrincipalPolicy(userS3Policy);
}
backend.classifyDocument.resources.lambda.addToRolePolicy(
  new iam.PolicyStatement({
    actions: ['bedrock:InvokeModel'],
    resources: ['arn:aws:bedrock:*::foundation-model/*'],
  })
);

backend.extractExpense.resources.lambda.addToRolePolicy(
  new iam.PolicyStatement({
    actions: ['textract:AnalyzeExpense'],
    resources: ['*'], 
  })
);

// =======================================================================
// 4. DYNAMODB INTEGRATION 
// =======================================================================
const documentTable = backend.data.resources.tables["DocumentRecord"];
documentTable.grantReadWriteData(backend.extractExpense.resources.lambda);
// ADD THIS LINE INSTEAD
const extractExpenseLambda = backend.extractExpense.resources.lambda as lambda.Function;


backend.extractExpense.addEnvironment("AMPLIFY_DATA_GRAPHQL_ENDPOINT", backend.data.resources.cfnResources.cfnGraphqlApi.attrGraphQlUrl);
backend.extractExpense.addEnvironment(
  "AMPLIFY_DATA_GRAPHQL_API_KEY", 
  backend.data.resources.cfnResources.cfnApiKey!.attrApiKey
);
// =======================================================================
// 5. DYNAMODB STREAM & SES EMAIL NOTIFICATION CONFIGURATION
// =======================================================================

// A. Forcefully enable the DynamoDB Stream
const cfnTable = backend.data.resources.cfnResources.amplifyDynamoDbTables["DocumentRecord"];

cfnTable.streamSpecification = {
  streamViewType: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES
};

// B. Define the Notification Lambda Function
const notifyCustomerFunction = new NodejsFunction(workflowStack, 'NotifyCustomerLambda', {
  entry: './amplify/functions/notifyCustomer/handler.ts',
  environment: {
    USER_POOL_ID: backend.auth.resources.userPool.userPoolId,
    SENDER_EMAIL: 'samir.amri@gmail.com'
  }
});

// C. Grant Permissions (Cognito, SES, and DynamoDB Stream reading)
notifyCustomerFunction.addToRolePolicy(new iam.PolicyStatement({
  actions: [
    'cognito-idp:AdminGetUser',
    'ses:SendEmail',
    'ses:VerifyEmailIdentity'
  ],
  resources: ['*']
}));

// D. Attach the DynamoDB Stream to the Lambda Function
notifyCustomerFunction.addEventSource(new DynamoEventSource(documentTable, {
  startingPosition: lambda.StartingPosition.LATEST,
  retryAttempts: 3, 
}));
// 6. GRANT LAMBDA PERMISSION TO MUTATE APPSYNC (Triggers Real-time Subscriptions)
backend.data.resources.graphqlApi.grantMutation(backend.extractExpense.resources.lambda);
// =======================================================================
// 6. MONTHLY COMPLIANCE REPORT GENERATOR (MOIC & NBR)
// =======================================================================
const reportsLambda = backend.generateReports.resources.lambda as lambda.Function;

existingBucket.grantReadWrite(reportsLambda);

reportsLambda.addEnvironment('AMPLIFY_DATA_GRAPHQL_ENDPOINT', backend.data.resources.cfnResources.cfnGraphqlApi.attrGraphQlUrl);
reportsLambda.addEnvironment('AMPLIFY_DATA_GRAPHQL_API_KEY', backend.data.resources.cfnResources.cfnApiKey!.attrApiKey);
reportsLambda.addEnvironment('BUCKET_NAME', existingBucket.bucketName);

// EventBridge Scheduler Rule (Triggers on the 1st of every month at 06:00 UTC)
const monthlyCronRule = new events.Rule(workflowStack, 'MonthlyReportsCronRule', {
  schedule: events.Schedule.cron({ day: '1', hour: '6', minute: '0' }),
});

monthlyCronRule.addTarget(new targets.LambdaFunction(reportsLambda));