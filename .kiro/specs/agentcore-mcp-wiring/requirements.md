# Requirements Document

## Introduction

This feature wires together four existing but disconnected components of the AccountAi financial compliance platform into a fully functional end-to-end pipeline:

1. **MCP Client** (`AccountAgents/app/AccountAgent/mcp_client/client.py`) — currently points to a dummy `mcp.exa.ai` endpoint; must be replaced with SigV4-authenticated calls to the deployed AccountMCP AgentCore runtime.
2. **Agent Main** (`AccountAgents/app/AccountAgent/main.py`) — currently has a placeholder `add_numbers` tool and a generic system prompt; must be replaced with the real MCP client wiring and a Financial Compliance system prompt that enforces multi-tenant isolation.
3. **Lambda Timeout** (`amplify/functions/chatAgent/resource.ts`) — currently set to 120 seconds, which is less than the MCP client timeout of 60 seconds plus agent processing overhead; must be raised to 900 seconds.
4. **Frontend** (`src/components/ChatAssistant.tsx`) — already correctly wired to AppSync; no changes required.

The AccountMCP server (`AccountAgents/app/AccountMcp/main.py`) is already deployed and exposes three DynamoDB tools: `get_document_details`, `list_client_documents`, and `calculate_tax_summary`. The AccountAgent AgentCore runtime is deployed at `arn:aws:bedrock-agentcore:us-east-1:559846026818:runtime/AccountAgents_AccountAg-7qdHnrEe5C`. The MCP server runtime is deployed at `arn:aws:bedrock-agentcore:us-east-1:559846026818:runtime/AccountAgents_AccountMCP-TXe1W1D7h0`.

## Glossary

- **AgentCore_Runtime**: The AWS Bedrock AgentCore hosted runtime that executes Python agent code. Referenced by its ARN.
- **AccountAgent**: The AgentCore runtime at ARN `arn:aws:bedrock-agentcore:us-east-1:559846026818:runtime/AccountAgents_AccountAg-7qdHnrEe5C` that receives prompts and calls MCP tools.
- **AccountMCP**: The AgentCore runtime at ARN `arn:aws:bedrock-agentcore:us-east-1:559846026818:runtime/AccountAgents_AccountMCP-TXe1W1D7h0` that exposes DynamoDB tools over the MCP Streamable HTTP protocol.
- **MCP_Client**: The Python module at `AccountAgents/app/AccountAgent/mcp_client/client.py` responsible for establishing an authenticated connection from AccountAgent to AccountMCP.
- **Agent_Main**: The Python module at `AccountAgents/app/AccountAgent/main.py` that defines the agent's system prompt, tool list, and entrypoint.
- **SigV4_Auth**: AWS Signature Version 4 request signing. Required by AgentCore runtimes to authenticate callers.
- **Lambda_Handler**: The AWS Lambda function at `amplify/functions/chatAgent/handler.ts` that invokes AccountAgent via `InvokeAgentRuntimeCommand` and returns parsed text to AppSync.
- **AppSync**: The AWS AppSync GraphQL API that receives `chatWithAgent` mutations from the frontend and routes them to Lambda_Handler.
- **accountantId**: The Cognito sub (UUID) of the accountant who owns a set of client records. Used as the tenant partition key.
- **customerId**: The Cognito sub (UUID) of the customer whose documents are being accessed. Used as the record partition key.
- **documentId**: The unique identifier of a specific document within a customer's record set.
- **SlidingWindowConversationManager**: A Strands SDK conversation manager that retains only the most recent N conversation turns.
- **NullConversationManager**: A Strands SDK conversation manager that discards all conversation state between turns.
- **Streamable_HTTP**: The MCP transport protocol that delivers tool results as a streaming HTTP response.

---

## Requirements

### Requirement 1: SigV4-Authenticated MCP Client

**User Story:** As an AccountAgent operator, I want the MCP client to authenticate requests to AccountMCP using AWS SigV4, so that the AgentCore runtime enforces IAM-based access control and rejects unauthenticated callers.

#### Acceptance Criteria

1. THE MCP_Client SHALL implement a `SigV4HttpxAuth` class that inherits from `httpx.Auth`.
2. WHEN MCP_Client constructs a `SigV4HttpxAuth` instance, THE MCP_Client SHALL retrieve AWS credentials via `boto3.Session().get_credentials()`, and IF no valid credentials are resolved, THEN THE MCP_Client SHALL raise an error indicating that AWS credentials could not be found before any request is attempted.
3. WHEN MCP_Client signs an outbound HTTP request, THE MCP_Client SHALL use `botocore.awsrequest.AWSRequest` with service name `bedrock-agentcore` and the AWS region read from the `AWS_DEFAULT_REGION` environment variable, falling back to `us-east-1` if the variable is absent or empty.
4. WHEN `SigV4HttpxAuth.auth_flow` is called, THE MCP_Client SHALL add an `Authorization` header to the outbound request whose value begins with the scheme `AWS4-HMAC-SHA256`, and the modified request SHALL include the `X-Amz-Date` header set to the signing timestamp in `YYYYMMDDTHHmmssZ` format.
5. THE MCP_Client SHALL construct the AccountMCP invocation URL as `https://bedrock-agentcore.{region}.amazonaws.com/runtimes/{encoded_arn}/invocations?qualifier=DEFAULT`, where `{region}` is the same region value used for signing in criterion 3, and `{encoded_arn}` is the AccountMCP ARN with every `:` replaced by `%3A` and every `/` replaced by `%2F`.
6. IF the AccountMCP ARN configuration value is absent or empty at startup, THEN THE MCP_Client SHALL raise an error indicating a missing ARN before constructing the invocation URL.
7. THE MCP_Client SHALL pass the `SigV4HttpxAuth` instance as the `auth` parameter when calling `streamablehttp_client`.
8. THE MCP_Client SHALL set `timeout=60.0` seconds on the `streamablehttp_client` call, where the timeout applies to the entire request-response cycle including connection establishment and response streaming.
9. THE MCP_Client SHALL contain no references to `mcp.exa.ai` or any other placeholder endpoint.
10. THE MCP_Client SHALL export a `get_streamable_http_mcp_client()` function that returns a `strands.tools.mcp.mcp_client.MCPClient` instance wrapping the SigV4-authenticated streamable HTTP transport.

### Requirement 2: Financial Compliance System Prompt

**User Story:** As an accountant using the Document Assistant, I want the AccountAgent to respond only with data belonging to my assigned clients, so that tenant data boundaries are never crossed and regulatory compliance is maintained.

#### Acceptance Criteria

1. THE Agent_Main SHALL define a `DEFAULT_SYSTEM_PROMPT` constant that instructs AccountAgent to act as a Financial Compliance Assistant.
2. THE Agent_Main SHALL include in `DEFAULT_SYSTEM_PROMPT` a statement that explicitly prohibits AccountAgent from returning financial data for any `customerId` other than the `customerId` supplied in the request context, such that the prohibition references the `customerId` identifier by name.
3. THE Agent_Main SHALL include in `DEFAULT_SYSTEM_PROMPT` a statement that explicitly prohibits AccountAgent from returning financial data associated with any `accountantId` other than the `accountantId` present in the request context, such that the prohibition references the `accountantId` identifier by name.
4. WHEN AccountAgent produces output containing tabular financial data (including transactions, account balances, or journal entries), THE Agent_Main SHALL instruct AccountAgent to format that data as a Markdown table with a header row and one data row per record.
5. THE Agent_Main SHALL contain no tool registered to the agent's tool list whose sole purpose is demonstration or testing rather than fulfilling a documented accountant workflow.
6. IF the request context does not supply a `customerId`, THEN THE Agent_Main SHALL instruct AccountAgent to refuse to return any financial data and to respond with a message indicating that the required client context is missing.

### Requirement 3: MCP Client Wiring in Agent Main

**User Story:** As an AccountAgent operator, I want Agent_Main to use the AccountMCP server as its sole tool source, so that the agent can query DynamoDB through the deployed MCP server.

#### Acceptance Criteria

1. THE Agent_Main SHALL import `get_streamable_http_mcp_client` from `mcp_client.client`.
2. THE Agent_Main SHALL construct `mcp_clients` as a list containing one element: the result of calling `get_streamable_http_mcp_client()`, where the MCP server URL is derived from the AccountMCP ARN stored in a configurable environment variable or constant, not hardcoded inline.
3. WHEN `agent_factory()` builds the `tools` list, THE Agent_Main SHALL append each element of `mcp_clients` that is not `None` to the `tools` list passed to the `Agent` constructor.
4. IF all elements of `mcp_clients` are `None`, THEN THE Agent_Main SHALL raise an error before constructing the `Agent` instance, indicating that no MCP tools are available.
5. THE Agent_Main SHALL NOT append any inline function tools to the `tools` list.
6. WHEN `agent_factory()` constructs an `Agent` instance, THE Agent_Main SHALL pass `DEFAULT_SYSTEM_PROMPT` as the `system_prompt` argument.

### Requirement 4: Conversation Manager Preservation

**User Story:** As an AccountAgent operator, I want the conversation manager configuration to remain unchanged, so that session memory behaviour is not accidentally altered during this wiring change.

#### Acceptance Criteria

1. THE Agent_Main SHALL retain the `_make_conversation_manager()` function definition with identical parameters, body, and return type as in the pre-wiring state.
2. WHEN `agent_factory()` constructs an `Agent` instance, THE Agent_Main SHALL pass the return value of `_make_conversation_manager()` as the `conversation_manager` keyword argument, with no other argument position or value change to that parameter.
3. THE Agent_Main SHALL retain the `get_memory_session_manager` import statement and all call sites of `get_memory_session_manager` within `agent_factory()` with identical arguments and assignment targets as in the pre-wiring state.

### Requirement 5: Lambda Timeout Uplift

**User Story:** As a platform engineer, I want the Lambda_Handler timeout to exceed the combined MCP client timeout and agent processing overhead, so that the Lambda never times out before the agent has a chance to complete a full tool-calling cycle.

#### Acceptance Criteria

1. THE Lambda_Handler SHALL be configured with `timeoutSeconds` set to exactly `900`.
2. THE Lambda_Handler's `timeoutSeconds` value SHALL be greater than or equal to `60` seconds, matching the MCP_Client's `timeout` value of `60.0` seconds, such that any future reduction of `timeoutSeconds` below `60` is a failing condition.
3. THE Lambda_Handler SHALL retain the `AGENT_RUNTIME_ARN` environment variable with the value `arn:aws:bedrock-agentcore:us-east-1:559846026818:runtime/AccountAgents_AccountAg-7qdHnrEe5C` unchanged; any modification to the key name or value string is a failing condition.
4. THE Lambda_Handler SHALL retain the `resourceGroupName` property set to the value `data` unchanged; any modification to the key name or value string is a failing condition.

### Requirement 6: Frontend Compatibility

**User Story:** As a developer, I want to confirm that the React frontend requires no changes to work with the updated agent pipeline, so that the wiring change is transparent to end users.

#### Acceptance Criteria

1. THE `sendMessage` function within ChatAssistant SHALL invoke agent responses exclusively via `client.mutations.chatWithAgent` and SHALL NOT contain any direct `fetch()`, `EventSource`, or SSE connection calls as its primary invocation path.
2. WHEN `sendMessage` calls `chatWithAgent`, THE ChatAssistant component SHALL pass `prompt`, `sessionId`, `accountantId`, `customerId`, and `documentId` as named arguments in the mutation call.
3. IF the Lambda_Handler returns a string containing `data:` prefixed lines with `contentBlockDelta` JSON (the defensive fallback condition), THEN THE ChatAssistant component SHALL extract and concatenate the delta text client-side such that the rendered output contains no raw `data:` lines.
4. THE ChatAssistant component SHALL strip complete `<thinking>…</thinking>` blocks, including multiline content, from any agent response before rendering; unclosed or partial tags SHALL be passed through to the renderer unchanged.

### Requirement 7: URL Encoding Correctness

**User Story:** As a platform engineer, I want the AccountMCP ARN to be correctly percent-encoded in the invocation URL, so that the AgentCore endpoint resolves to the right runtime and rejects malformed URLs.

#### Acceptance Criteria

1. WHEN MCP_Client constructs the invocation URL, THE MCP_Client SHALL replace every `:` character within the AccountMCP ARN string (not the base URL or path segments) with the percent-encoded sequence `%3A`.
2. WHEN MCP_Client constructs the invocation URL, THE MCP_Client SHALL replace every `/` character within the AccountMCP ARN string (not the base URL or path segments) with the percent-encoded sequence `%2F`.
3. THE MCP_Client SHALL produce the exact encoded ARN `arn%3Aaws%3Abedrock-agentcore%3Aus-east-1%3A559846026818%3Aruntime%2FAccountAgents_AccountMCP-TXe1W1D7h0` from the source ARN `arn:aws:bedrock-agentcore:us-east-1:559846026818:runtime/AccountAgents_AccountMCP-TXe1W1D7h0`.
4. THE MCP_Client SHALL append `?qualifier=DEFAULT` as the sole query string parameter to the invocation URL, with no additional query parameters appended.
