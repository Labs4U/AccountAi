import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource';
import { data } from './data/resource';
import { storage } from './storage/resource';
import { classifyDocument } from './functions/classifyDocument/resource';
import { extractExpense } from './functions/extractExpense/resource';

import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Duration } from 'aws-cdk-lib';

const backend = defineBackend({
  auth,
  data,
  storage,
  classifyDocument,
  extractExpense,
});

const workflowStack = backend.createStack('DocumentProcessingWorkflow');

// =======================================================================
// 1. WORKFLOW TASKS DEFINITION
// =======================================================================

// Ingest State
const initProcessingTask = new sfn.Pass(workflowStack, 'InitProcessing_SetState', {
  parameters: {
    'input.$': '$',
    'status': 'PROCESSING',
    'timestamp.$': '$$.Execution.StartTime'
  },
  resultPath: '$.ingestResult'
});

// Classify Task (Invokes classifyDocument function)
const classifyTask = new tasks.LambdaInvoke(workflowStack, 'ClassifyDocumentTask', {
  lambdaFunction: backend.classifyDocument.resources.lambda,
  payload: sfn.TaskInput.fromJsonPathAt('$'),
  resultPath: '$.classificationResult',
  outputPath: '$',
});

// Extract Expense Task
const extractExpenseTask = new tasks.LambdaInvoke(workflowStack, 'ExtractExpense_Textract', {
  lambdaFunction: backend.extractExpense.resources.lambda,
  payload: sfn.TaskInput.fromObject({
    documentType: sfn.JsonPath.stringAt('$.classificationResult.Payload.documentType'),
    bucket: sfn.JsonPath.stringAt('$.classificationResult.Payload.bucket'),
    key: sfn.JsonPath.stringAt('$.classificationResult.Payload.key')
  }),
  resultPath: '$.extractionRawResult',
});

// Fallback State
const ignoreTask = new sfn.Pass(workflowStack, 'IgnoreUnsupportedDocType', {
  result: sfn.Result.fromObject({ status: 'SKIPPED', reason: 'Unsupported document category' }),
});

// Choice State: Route based on document type
const routingChoice = new sfn.Choice(workflowStack, 'RouteByDocumentType')
  .when(
    sfn.Condition.or(
      sfn.Condition.stringEquals('$.classificationResult.Payload.documentType', 'RECEIPT'),
      sfn.Condition.stringEquals('$.classificationResult.Payload.documentType', 'INVOICE')
    ),
    extractExpenseTask
  )
  .otherwise(ignoreTask);

// Assemble Workflow Chain
const definition = initProcessingTask
  .next(classifyTask)
  .next(routingChoice);

// Create Express State Machine
const stateMachine = new sfn.StateMachine(workflowStack, 'DocProcessingStateMachine', {
  definitionBody: sfn.DefinitionBody.fromChainable(definition),
  stateMachineType: sfn.StateMachineType.EXPRESS,
  timeout: Duration.minutes(5),
});

// =======================================================================
// 2. S3 & EVENTBRIDGE TRIGGER CONFIGURATION
// =======================================================================
const bucket = backend.storage.resources.bucket;
const cfnBucket = bucket.node.defaultChild as s3.CfnBucket;

// Enable EventBridge notifications on S3 bucket
cfnBucket.notificationConfiguration = {
  eventBridgeConfiguration: { eventBridgeEnabled: true }
};

// EventBridge Rule listening for object creations
const s3UploadRule = new events.Rule(workflowStack, 'S3UploadRule', {
  eventPattern: {
    source: ['aws.s3'],
    detailType: ['Object Created'],
    detail: {
      bucket: { name: [bucket.bucketName] }
    }
  }
});

s3UploadRule.addTarget(new targets.SfnStateMachine(stateMachine));

// =======================================================================
// 3. IAM & BUCKET PERMISSIONS
// =======================================================================
bucket.grantReadWrite(backend.classifyDocument.resources.lambda);
bucket.grantReadWrite(backend.extractExpense.resources.lambda);

// Grant Amazon Bedrock permission for Nova Lite model calls
backend.classifyDocument.resources.lambda.addToRolePolicy(
  new iam.PolicyStatement({
    actions: ['bedrock:InvokeModel'],
    resources: ['arn:aws:bedrock:*::foundation-model/*'],
  })
);