import type { AppSyncResolverHandler } from 'aws-lambda';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';

const agentClient = new BedrockAgentCoreClient({
  region: process.env.AWS_REGION ?? 'us-east-1',
});

interface ChatAgentArguments {
  prompt: string;
  sessionId: string;
  accountantId?: string;
  customerId?: string;
  documentId?: string;
}

/**
 * Parses raw AgentCore SSE wire format into clean text.
 *
 * AgentCore streams newline-delimited SSE events:
 *   data: {"event":{"contentBlockDelta":{"delta":{"text":"Hello"}}}}
 *   data: {"event":{"contentBlockDelta":{"delta":{"text":" world"}}}}
 *   data: [DONE]
 *
 * This function concatenates all delta.text values and strips <thinking> blocks.
 */
function parseSseStream(raw: string): string {
  let text = '';

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;

    const chunk = trimmed.slice(5).trim();
    if (!chunk || chunk === '[DONE]') continue;

    try {
      const parsed = JSON.parse(chunk);
      text += parsed?.event?.contentBlockDelta?.delta?.text ?? '';
    } catch {
      // unparseable chunk — skip
    }
  }

  // Strip internal reasoning blocks that must not reach the user
  return text.replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, '').trim();
}

export const handler: AppSyncResolverHandler<ChatAgentArguments, string> = async (event) => {
  const { prompt, sessionId, accountantId, customerId, documentId } = event.arguments;

  const agentRuntimeArn = process.env.AGENT_RUNTIME_ARN ?? '';
  if (!agentRuntimeArn) {
    throw new Error('AGENT_RUNTIME_ARN environment variable is required.');
  }

  // Determine caller role from Cognito group membership
  const groups: string[] = (event.identity as any)?.groups ?? [];
  const viewerRole = groups.includes('Admin') ? 'ACCOUNTANT' : 'CUSTOMER';

  // Build enriched prompt with system context for the agent
  const enrichedPrompt =
    `${prompt}\n\n` +
    `[SYSTEM CONTEXT: The user asking this question is a(n) ${viewerRole}. ` +
    `accountantId=${accountantId ?? ''}, customerId=${customerId ?? ''}, documentId=${documentId ?? ''}. ` +
    `Use your tools to fetch relevant data before responding. Always respect multi-tenant boundaries.]`;

  // AgentCore expects the body as a UTF-8 encoded JSON object
  const payload = new TextEncoder().encode(
    JSON.stringify({ prompt: enrichedPrompt })
  );

  const command = new InvokeAgentRuntimeCommand({
    agentRuntimeArn,
    qualifier: 'DEFAULT',
    runtimeSessionId: sessionId,
    payload,
  });

  const agentResponse = await agentClient.send(command);

  if (!agentResponse.response) {
    return 'The agent returned an empty response.';
  }

  // transformToString() buffers the full SSE stream as a single string
  const rawSse = await agentResponse.response.transformToString('utf-8');

  const cleanText = parseSseStream(rawSse);

  return cleanText || 'The agent returned an empty response.';
};
