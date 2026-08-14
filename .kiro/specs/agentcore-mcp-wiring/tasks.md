# Implementation Plan: agentcore-mcp-wiring

## Overview

Wire together the AccountAi financial compliance pipeline by creating the SigV4-authenticated MCP client, writing the agent entrypoint with a Financial Compliance system prompt, raising the Lambda timeout, and covering the implementation with unit and property-based tests. The frontend (`ChatAssistant.tsx`) and Lambda handler (`handler.ts`) require no changes.

## Tasks

- [ ] 1. Set up MCP client package structure
  - Create `AccountAgents/app/AccountAgent/mcp_client/__init__.py` as an empty file to mark the package
  - Create `AccountAgents/app/AccountAgent/tests/` directory with an empty `__init__.py`
  - _Requirements: 1.1, 3.1_

- [ ] 2. Implement `SigV4HttpxAuth` and URL helper in `client.py`
  - [ ] 2.1 Implement `SigV4HttpxAuth` class
    - Inherit from `httpx.Auth`
    - In `__init__`, call `boto3.Session().get_credentials()`; raise `RuntimeError("AWS credentials could not be resolved")` if result is `None`
    - Accept `service` (default `"bedrock-agentcore"`) and `region` (default from `AWS_DEFAULT_REGION` env var, fallback `"us-east-1"`)
    - In `auth_flow`, build a `botocore.awsrequest.AWSRequest`, apply `botocore.auth.SigV4Auth`, then copy `Authorization` and `X-Amz-Date` headers onto the `httpx.Request` and yield it
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

  - [ ]* 2.2 Write property test for SigV4 Authorization header format (Property 1)
    - **Property 1: SigV4 Authorization Header Format**
    - **Validates: Requirements 1.4**
    - Use `hypothesis` `@given` with sampled HTTP methods, URL regex, and binary body
    - Mock `boto3.Session` to return fake credentials so no real AWS call is made
    - Assert `Authorization` starts with `"AWS4-HMAC-SHA256"` and `X-Amz-Date` matches `\d{8}T\d{6}Z`
    - `@settings(max_examples=100)`
    - Tag: `# Feature: agentcore-mcp-wiring, Property 1: SigV4 Authorization header format`

  - [ ] 2.3 Implement `_build_invocation_url` helper
    - Pure function: accepts `arn` and `region` strings
    - Replace `:` with `%3A` and `/` with `%2F` within the ARN segment only
    - Return `https://bedrock-agentcore.{region}.amazonaws.com/runtimes/{encoded_arn}/invocations?qualifier=DEFAULT`
    - _Requirements: 1.5, 7.1, 7.2, 7.3, 7.4_

  - [ ]* 2.4 Write property test for ARN percent-encoding round-trip (Property 2)
    - **Property 2: ARN Percent-Encoding Round-Trip**
    - **Validates: Requirements 1.5, 7.1, 7.2, 7.4**
    - Use `hypothesis` `@given` with 12-digit account IDs, alphanumeric runtime suffixes, and sampled regions
    - Build a synthetic ARN, call `_build_invocation_url`, extract the ARN segment between `/runtimes/` and `/invocations`
    - Assert no raw `:` or `/` in the ARN segment, and URL ends with `?qualifier=DEFAULT`
    - `@settings(max_examples=100)`
    - Tag: `# Feature: agentcore-mcp-wiring, Property 2: ARN percent-encoding round-trip`

- [ ] 3. Implement `get_streamable_http_mcp_client` in `client.py`
  - [ ] 3.1 Implement factory function
    - Read `ACCOUNT_MCP_ARN` env var; raise `RuntimeError("ACCOUNT_MCP_ARN is required")` if absent or empty
    - Read region from `AWS_DEFAULT_REGION`, fallback `"us-east-1"`
    - Call `_build_invocation_url(arn, region)` to construct the URL
    - Instantiate `SigV4HttpxAuth(service="bedrock-agentcore", region=region)`
    - Pass `auth` and `timeout=60.0` to `streamablehttp_client` from `mcp.client.streamable_http`
    - Wrap with `MCPClient` from `strands.tools.mcp.mcp_client` and return it
    - _Requirements: 1.5, 1.6, 1.7, 1.8, 1.9, 1.10_

  - [ ]* 3.2 Write unit tests for `get_streamable_http_mcp_client`
    - Test raises `RuntimeError` when `ACCOUNT_MCP_ARN` is not set (env var absent)
    - Test raises `RuntimeError` when `ACCOUNT_MCP_ARN` is set to empty string `""`
    - Test raises `RuntimeError` when `boto3.Session().get_credentials()` returns `None`
    - Test that the constructed URL for the known AccountMCP ARN exactly equals `https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/arn%3Aaws%3Abedrock-agentcore%3Aus-east-1%3A559846026818%3Aruntime%2FAccountAgents_AccountMCP-TXe1W1D7h0/invocations?qualifier=DEFAULT`
    - _Requirements: 1.6, 7.3_

- [ ] 4. Checkpoint — Ensure `client.py` tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 5. Implement `main.py`
  - [ ] 5.1 Define `DEFAULT_SYSTEM_PROMPT`
    - Write the module-level constant instructing AccountAgent to act as a Financial Compliance Assistant
    - Include explicit prohibition on returning data for any `customerId` other than the one in the request context
    - Include explicit prohibition on returning data for any `accountantId` other than the one in the request context
    - Include instruction to format tabular financial data as Markdown tables
    - Include instruction to refuse and report missing context when `customerId` is absent from the request context
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.6_

  - [ ] 5.2 Preserve `_make_conversation_manager` and retain imports
    - Copy the existing `_make_conversation_manager()` function verbatim (identical parameters, body, return type)
    - Retain the `get_memory_session_manager` import and all its call sites with identical arguments
    - _Requirements: 4.1, 4.3_

  - [ ] 5.3 Implement `agent_factory`
    - Import `get_streamable_http_mcp_client` from `mcp_client.client`
    - Build `mcp_clients` list with one element: the result of `get_streamable_http_mcp_client()`
    - Filter `mcp_clients` to exclude `None`; raise `RuntimeError("No MCP tools available")` if the filtered list is empty
    - Construct `Agent` with `tools=<filtered list>`, `system_prompt=DEFAULT_SYSTEM_PROMPT`, `conversation_manager=_make_conversation_manager()`
    - Do NOT append any inline function tools to the tools list
    - _Requirements: 2.5, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 4.2_

  - [ ]* 5.4 Write unit tests for `main.py`
    - Test `agent_factory()` raises `RuntimeError` when all `mcp_clients` are `None` (mock `get_streamable_http_mcp_client` to return `None`)
    - Test `DEFAULT_SYSTEM_PROMPT` contains literal strings `customerId` and `accountantId`
    - Test `DEFAULT_SYSTEM_PROMPT` contains a prohibition against returning financial data for mismatched IDs
    - _Requirements: 2.2, 2.3, 3.4_

- [ ] 6. Write SSE and thinking-block property tests
  - [ ] 6.1 Write property test for SSE delta extraction completeness (Property 3)
    - **Property 3: SSE Delta Extraction Completeness**
    - **Validates: Requirements 6.3**
    - Import `parse_sse_stream` (pure extraction function without thinking-block strip) from `handler.ts` equivalent or a shared Python helper if one exists; if not, test the TypeScript function indirectly via the property specification
    - Use `hypothesis` `@given` with lists of text fragments (0–20 items, max 80 chars each)
    - Build synthetic SSE byte string with `data: {…contentBlockDelta…}` lines followed by `data: [DONE]`
    - Assert extracted text equals `"".join(texts)`
    - `@settings(max_examples=100)`
    - Tag: `# Feature: agentcore-mcp-wiring, Property 3: SSE delta extraction completeness`
    - _Requirements: 6.3_

  - [ ] 6.2 Write property test for thinking block stripping (Property 4)
    - **Property 4: Thinking Block Stripping**
    - **Validates: Requirements 6.4**
    - Import `strip_thinking_blocks` (pure regex helper) from the relevant module
    - Use `hypothesis` `@given` with `prefix`, `inner`, `suffix` texts (max 200/500/200 chars)
    - Assert result contains no `<thinking>` or `</thinking>` after stripping a complete block
    - Assert content outside thinking blocks is preserved
    - `@settings(max_examples=100)`
    - Tag: `# Feature: agentcore-mcp-wiring, Property 4: Thinking block stripping`
    - _Requirements: 6.4_

- [ ] 7. Modify Lambda timeout in `resource.ts`
  - Change `timeoutSeconds: 120` to `timeoutSeconds: 900` in `amplify/functions/chatAgent/resource.ts`
  - Verify all other properties (`name`, `entry`, `resourceGroupName`, `AGENT_RUNTIME_ARN`) are unchanged
  - _Requirements: 5.1, 5.2, 5.3, 5.4_

- [ ] 8. Verify `ChatAssistant.tsx` compliance (read-only check)
  - Read `src/components/ChatAssistant.tsx` and confirm:
    - `sendMessage` calls `client.mutations.chatWithAgent` and contains no direct `fetch()` or `EventSource` as the primary path (Requirement 6.1)
    - The mutation passes `prompt`, `sessionId`, `accountantId`, `customerId`, and `documentId` (Requirement 6.2)
    - SSE fallback stripping is present (Requirement 6.3)
    - `<thinking>` block stripping regex is present (Requirement 6.4)
  - Make no edits; document any deviations found
  - _Requirements: 6.1, 6.2, 6.3, 6.4_

- [ ] 9. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Property tests use `hypothesis` with `@settings(max_examples=100)` and must be tagged with `# Feature: agentcore-mcp-wiring, Property N: …`
- `_build_invocation_url` MUST be extracted as a pure helper to allow property test 2 to run without httpx overhead
- Properties 3 and 4 target the SSE parsing and thinking-block stripping already present in `handler.ts` / `ChatAssistant.tsx`; if those functions are TypeScript-only, the Python property tests serve as a specification-level verification and should document this constraint
- Integration tests (Lambda → AccountAgent → AccountMCP) are out of scope for this task list; they require live AWS credentials and are tracked separately

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1"] },
    { "id": 1, "tasks": ["2.1", "2.3"] },
    { "id": 2, "tasks": ["2.2", "2.4", "3.1"] },
    { "id": 3, "tasks": ["3.2", "5.1"] },
    { "id": 4, "tasks": ["5.2", "5.3"] },
    { "id": 5, "tasks": ["5.4", "6.1", "6.2", "7"] },
    { "id": 6, "tasks": ["8"] }
  ]
}
```
