import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource';
import { data } from './data/resource';
import { classifyDocument } from './functions/classifyDocument/resource';
import { extractExpense } from './functions/extractExpense/resource';

import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Duration } from 'aws-cdk-lib';

// 1. Remove 'storage' from the backend definition
const backend = defineBackend({
  auth,
  data,
  classifyDocument,
  extractExpense,
});

const workflowStack = backend.createStack('DocumentProcessingWorkflow');

// =======================================================================
// 1. WORKFLOW TASKS DEFINITION (Unchanged)
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
  stateMachineType: sfn.StateMachineType.STANDARD, // <--- CHANGED THIS TO STANDARD
  timeout: Duration.minutes(5),
});

// =======================================================================
// 2. CONNECT TO EXISTING S3 BUCKET & EVENTBRIDGE
// =======================================================================

// Reference your existing manual bucket
const existingBucket = s3.Bucket.fromBucketName(workflowStack, 'AccountAiBucket', 'account-ai-bh');

// EventBridge Rule listening for object creations in the raw folder
const s3UploadRule = new events.Rule(workflowStack, 'S3UploadRule', {
  eventPattern: {
    source: ['aws.s3'],
    detailType: ['Object Created'],
    detail: {
      bucket: { name: [existingBucket.bucketName] },
      // Put this back! EventBridge wildcard matching will now work securely.
      object: {
        key: [{ wildcard: "*/raw/*" }] 
      }
    }
  }
});

s3UploadRule.addTarget(new targets.SfnStateMachine(stateMachine));

// =======================================================================
// 3. IAM & BUCKET PERMISSIONS
// =======================================================================

// Grant Lambda read/write to the existing bucket
existingBucket.grantReadWrite(backend.classifyDocument.resources.lambda);
existingBucket.grantReadWrite(backend.extractExpense.resources.lambda);

// Grant Customer/React users the ability to upload to this specific bucket
const userS3Policy = new iam.PolicyStatement({
  actions: ['s3:PutObject', 's3:GetObject', 's3:DeleteObject'],
  resources: ['arn:aws:s3:::account-ai-bh/*'] // CHANGED
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
// 4. DYNAMODB INTEGRATION (Unchanged)
// =======================================================================
const documentTable = backend.data.resources.tables["DocumentRecord"];
documentTable.grantReadWriteData(backend.extractExpense.resources.lambda);
backend.extractExpense.addEnvironment("DOCUMENT_TABLE_NAME", documentTable.tableName);