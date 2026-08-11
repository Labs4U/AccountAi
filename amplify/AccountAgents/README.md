# AccountAi Agent Architecture

## Overview

This folder contains the multi-tenant Financial Compliance Agent for AccountAi, adapted from the EWA reference architecture. The system consists of three integrated components:

1. **AccountMcp Server** (Python FastMCP) - DynamoDB query layer with multi-tenant isolation
2. **Bedrock Agent Configuration** - Claude-3.5-Sonnet with financial compliance instructions
3. **React ChatAssistant** - Frontend component for agent interaction

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                     React ChatAssistant (Frontend)                  │
│  - Props: documentId, userId, accountantId                          │
│  - Enriches prompt with multi-tenant context                        │
│  - Calls GATEWAY_URL with sessionId & all 3 tenant params           │
└────────────────────────┬────────────────────────────────────────────┘
                         │
                         │ HTTP POST
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│            Lambda Gateway / Bedrock Agent Orchestration             │
│  - Authenticates request (userId, accountantId)                     │
│  - Invokes Bedrock Agent with enriched prompt + context             │
│  - Streams response back via SSE                                    │
└────────────────────────┬────────────────────────────────────────────┘
                         │
                         │ Bedrock Agent Runtime
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│           Bedrock Agent (Claude-3.5-Sonnet)                         │
│  - System Prompt: Financial compliance instructions                 │
│  - Tool Choice: Auto (uses tools when appropriate)                  │
│  - Max Tokens: 4096                                                 │
│  - Context: accountantId, userId, documentId in prompt              │
└────────────────────────┬────────────────────────────────────────────┘
                         │
        ┌────────────────┼────────────────┐
        │                │                │
   Function Call    Function Call    Function Call
        │                │                │
        ▼                ▼                ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│get_document_     │ │list_client_      │ │calculate_tax_    │
│details()         │ │documents()       │ │summary()         │
└────────┬─────────┘ └────────┬─────────┘ └────────┬─────────┘
         │                    │                    │
         └────────────────────┼────────────────────┘
                              │
                              ▼
         ┌────────────────────────────────────┐
         │    AccountMcp Server (FastMCP)     │
         │                                    │
         │  Multi-Tenant Isolation Layer:    │
         │  - Validates accountantId + userId │
         │  - Enforces GSI queries             │
         │  - Filters by tenant context       │
         └────────────────────┬───────────────┘
                              │
                              ▼
         ┌────────────────────────────────────┐
         │      DynamoDB DocumentRecord       │
         │                                    │
         │  Primary Key: userId + documentId  │
         │  GSI: accountantId + status        │
         │                                    │
         │  Filters ensure:                   │
         │  - Only data for this accountant   │
         │  - Only data for this customer     │
         │  - No cross-tenant leakage         │
         └────────────────────────────────────┘
```

## Components

### 1. AccountMcp Server (`app/AccountMcp/main.py`)

A FastMCP server that provides three tools with built-in multi-tenant isolation:

#### Tool: `get_document_details`
```python
def get_document_details(documentId: str, userId: str, accountantId: str) -> str
```
- **Purpose**: Fetch metadata for a single document
- **Multi-tenant**: Validates document.accountantId == parameter.accountantId
- **Returns**: JSON with vendor, total, tax, date, status, mappings, confidence scores

#### Tool: `list_client_documents`
```python
def list_client_documents(userId: str, accountantId: str, status: str = None) -> str
```
- **Purpose**: List all documents for a customer
- **Multi-tenant**: 
  - Queries GSI: `accountantId-status-index`
  - Filters by userId (application-level)
  - Excludes profile records (only DOCUMENT records)
  - Optional status filter
- **Returns**: JSON array with document summaries

#### Tool: `calculate_tax_summary`
```python
def calculate_tax_summary(userId: str, accountantId: str) -> str
```
- **Purpose**: Aggregate tax across FINALIZED documents
- **Multi-tenant**: 
  - Queries GSI with status filter ("FINALIZED")
  - Filters by userId
  - Excludes profiles
- **Returns**: JSON with totalTax, documentCount, dateRange, contributing documents

**Key Security Feature**: All tools validate `accountantId` and `userId` parameters. If document ownership is not verified, access is denied.

### 2. Bedrock Agent Configuration

#### `agent-config.json`
- **Model**: us.anthropic.claude-3-5-sonnet-20241022
- **Max Tokens**: 4096
- **Temperature**: 0.3 (precise, deterministic responses)
- **Tool Use**: Auto (agent decides when to use tools)
- **Tools**: All three AccountMcp tools registered

#### `system-prompt.md`
Comprehensive instructions for the agent covering:
- Role as Financial Compliance Assistant
- Multi-tenant isolation requirements
- Tool usage guidelines
- Compliance focus areas
- Error handling and security

### 3. React ChatAssistant Component (`src/components/ChatAssistant.tsx`)

#### Props
```typescript
interface ChatAssistantProps {
  documentId: string    // Document being analyzed
  userId: string        // Customer identifier
  accountantId: string  // Accountant identifier (NEW)
  onClose?: () => void
}
```

#### Key Changes from Original
1. **Added `accountantId` prop** - Required for multi-tenant context
2. **Session ID includes accountantId**: `doc_session_{accountantId}_{userId}_{documentId}`
3. **Enriched prompt** includes all three context variables
4. **Request payload** passes `accountantId` and `actor: accountantId`
5. **Suggested prompts** updated for financial compliance focus

#### Suggested Prompts
```
- "What are the tax implications of this expense?"
- "Is this document compliant with our policies?"
- "Summarize the key financial details"
- "Flag any potential compliance issues"
```

## Multi-Tenant Isolation Enforcement

This architecture enforces multi-tenant isolation at **every layer**:

### 1. Frontend (ChatAssistant.tsx)
- Requires `accountantId` prop
- Includes in every session ID and request

### 2. Gateway/Lambda
- Authenticates request origin
- Validates Cognito token includes accountantId
- Passes full context to agent

### 3. Bedrock Agent
- Receives accountantId + userId in enriched prompt
- Passes to every tool call

### 4. AccountMcp Server
- **Tool Parameters**: Every tool requires both `accountantId` and `userId`
- **Ownership Validation**: `get_document_details` verifies document.accountantId == parameter
- **Query Filtering**: 
  - `list_client_documents` queries by accountantId GSI, then filters by userId
  - `calculate_tax_summary` queries by accountantId GSI, then filters by userId

### 5. DynamoDB
- Primary Key: `userId` + `documentId`
- GSI: `accountantId` + `status`
- Application-level filtering ensures no cross-tenant leakage

## Deployment

### Step 1: Deploy AccountMcp Server
```bash
cd amplify/AccountAgents/app/AccountMcp
pip install -r requirements.txt
# Deploy to AWS Lambda or ECS with environment variables:
# - DYNAMODB_TABLE_NAME=DocumentRecord
# - AWS_REGION=us-east-1
```

### Step 2: Configure Bedrock Agent
```bash
# In AWS Console or via AWS CLI:
# 1. Create Agent with agent-config.json
# 2. Add system-prompt.md as instructions
# 3. Register AccountMcp as MCP tool endpoint
# 4. Create Agent Alias for production
```

### Step 3: Update Frontend
The ChatAssistant.tsx updates are already in place. Usage:

```typescript
<ChatAssistant
  documentId="doc-123"
  userId="user-456"
  accountantId="acct-789"
  onClose={() => setShowChat(false)}
/>
```

## Testing Multi-Tenant Isolation

### Test Case 1: Verify Access Control
```bash
# Tool call with mismatched accountantId
get_document_details(
  documentId="doc-123",
  userId="user-456",
  accountantId="wrong-acct"  # Document belongs to acct-789
)
# Expected: "Access denied: Document does not belong to this accountant"
```

### Test Case 2: Verify Data Filtering
```bash
# List documents for customer across accountants
list_client_documents(userId="user-456", accountantId="acct-789")
# Expected: Only documents where accountantId == "acct-789" AND userId == "user-456"
```

### Test Case 3: Verify Tax Aggregation
```bash
# Calculate tax for specific accountant-customer pair
calculate_tax_summary(userId="user-456", accountantId="acct-789")
# Expected: Sum of extractedTax ONLY for acct-789 + user-456 pair
```

## Error Scenarios

### Scenario 1: Document Not Found
```json
{
  "error": "Document not found",
  "documentId": "doc-999",
  "userId": "user-456"
}
```

### Scenario 2: Access Denied (Wrong Accountant)
```json
{
  "error": "Access denied: Document does not belong to this accountant or user",
  "documentId": "doc-123",
  "userId": "user-456",
  "accountantId": "wrong-acct"
}
```

### Scenario 3: Missing Multi-Tenant Context
```json
{
  "error": "accountantId is required and cannot be empty"
}
```

## GSI Reference

The implementation uses the `listByAccountantAndStatus` GSI from the DocumentRecord schema:

```
Index Name: accountantId-status-index
Partition Key: accountantId
Sort Key: status
```

This GSI enables efficient queries for:
- All documents assigned to an accountant
- All documents with a specific status for an accountant
- All finalized documents for an accountant (used by calculate_tax_summary)

## Security Considerations

1. **No Table Scans**: All queries use indexed access (GSI)
2. **Application-Level Filtering**: userId filter applied after GSI query
3. **Ownership Validation**: Documents verified to belong to the accountant
4. **Tool-Level Enforcement**: Every tool validates both accountantId and userId
5. **No Speculative Responses**: Agent only acts on tool data, never guesses

## References

- EWA Reference: MCP pattern for FastMCP + Bedrock integration
- DocumentRecord Schema: DynamoDB table with GSIs
- Bedrock Agent Documentation: Function calling and tool integration
- FastMCP Documentation: Python MCP framework for AWS services

## Version

- **AccountMcp**: 1.0.0
- **Agent Config**: 1.0.0
- **System Prompt**: 1.0.0
- **ChatAssistant**: Updated for accountantId support

---

**Last Updated**: 2024  
**Framework**: FastMCP + Bedrock + React  
**Multi-Tenant**: Yes - accountantId + userId isolation at all layers
