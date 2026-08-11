# AccountAi Multi-Tenant Agent Implementation Guide

## Overview

This guide provides step-by-step instructions to deploy and integrate the multi-tenant Financial Compliance Agent architecture. The system consists of:

1. **Frontend**: Updated `ChatAssistant.tsx` component (React/TypeScript)
2. **Backend**: `AccountMcp/main.py` FastMCP server (Python)
3. **Agent Config**: Bedrock agent configuration with Claude-3.5-Sonnet
4. **System Prompt**: Financial compliance instructions for the agent

---

## Phase 1: Frontend Changes ✅ (COMPLETED)

### Changes Made

#### File: `src/components/ChatAssistant.tsx`

**Props Update:**
```typescript
interface ChatAssistantProps {
  documentId: string
  userId: string
  accountantId: string    // NEW
  onClose?: () => void
}
```

**Session ID Format:**
```typescript
const [sessionId] = useState(() => `doc_session_${accountantId}_${userId}_${documentId}`)
```

**Enriched Prompt:**
```typescript
const enrichedPrompt = `${trimmed}\n\n[CONTEXT: Accountant ${accountantId} is analyzing document ${documentId} for customer ${userId}. Use available tools to fetch relevant data before responding. Focus on financial compliance and tax implications.]`
```

**Request Payload:**
```javascript
body: JSON.stringify({
  prompt: enrichedPrompt,
  sessionId,
  documentId,
  userId,
  accountantId,      // NEW
  actor: accountantId, // Changed from userId
})
```

**Suggested Prompts (Updated):**
- "What are the tax implications of this expense?"
- "Is this document compliant with our policies?"
- "Summarize the key financial details"
- "Flag any potential compliance issues"

#### File: `src/components/AccountantDashboard.tsx`

**ChatAssistant Instantiation:**
```typescript
<ChatAssistant 
  documentId={selectedDocument ? selectedDocument.documentId : "dashboard_general"} 
  userId={accountantSub}
  accountantId={accountantSub}  // NEW
/>
```

#### File: `src/components/CustomerPortal.tsx`

**ChatAssistant Instantiation:**
```typescript
<ChatAssistant 
  documentId={selectedDocument.documentId} 
  userId={selectedDocument.userId}
  accountantId={selectedDocument.accountantId || ""}  // NEW
/>
```

### Frontend Testing

Build verification:
```bash
npm run build
# Should compile with only unused variable warnings (non-blocking)
```

---

## Phase 2: Backend Setup - AccountMcp Server

### Prerequisites

- Python 3.9+
- AWS Lambda or ECS deployment capability
- DynamoDB access (DocumentRecord table)
- Boto3 credentials configured

### File: `amplify/AccountAgents/app/AccountMcp/main.py`

**Location:** `/Users/amrifamily/AWS/project/AccountAi/amplify/AccountAgents/app/AccountMcp/main.py`

**Key Features:**

1. **FastMCP Server**: Uses `fastmcp` framework for tool registration
2. **Multi-Tenant Isolation**: Every tool validates `accountantId` AND `userId`
3. **GSI Optimization**: Queries use `listByAccountantAndStatus` GSI
4. **JSON Serialization**: Decimal objects converted to floats for API responses

### Three Tools Implemented

#### 1. `get_document_details(documentId, userId, accountantId)`

**Purpose:** Fetch metadata for a single document with access control

**Implementation:**
```python
@mcp.tool()
def get_document_details(documentId: str, userId: str, accountantId: str) -> str:
    """Fetch document metadata for multi-tenant access control."""
    # Validates accountantId and userId
    # Queries: table.get_item(Key={"userId": userId, "documentId": documentId})
    # Ownership check: document.accountantId == parameter.accountantId
    # Returns: JSON with vendor, total, tax, date, status, mappings
```

**Response:**
```json
{
  "documentId": "doc-123",
  "userId": "user-456",
  "accountantId": "acct-789",
  "vendor": "ABC Supplies",
  "total": 1500.0,
  "tax": 150.0,
  "date": "2024-01-15",
  "status": "FINALIZED",
  "docType": "INVOICE",
  "mappedAccountCode": "6200",
  "mappedAccountName": "Supplies Expense",
  "aiConfidenceScore": 0.94
}
```

**Error Handling:**
```json
{
  "error": "Access denied: Document does not belong to this accountant or user"
}
```

#### 2. `list_client_documents(userId, accountantId, status?)`

**Purpose:** List all documents for a customer with optional status filter

**Implementation:**
```python
@mcp.tool()
def list_client_documents(userId: str, accountantId: str, status: str = None) -> str:
    """Fetch documents using GSI with multi-tenant filters."""
    # Queries GSI: accountantId-status-index
    # Filters: userId match + recordType == "DOCUMENT"
    # Optional: status filter on GSI sort key
    # Returns: JSON array of documents
```

**Response:**
```json
{
  "count": 5,
  "userId": "user-456",
  "accountantId": "acct-789",
  "statusFilter": "FINALIZED",
  "documents": [
    {
      "documentId": "doc-123",
      "vendor": "ABC Supplies",
      "total": 1500.0,
      "tax": 150.0,
      "date": "2024-01-15",
      "status": "FINALIZED"
    }
  ]
}
```

#### 3. `calculate_tax_summary(userId, accountantId)`

**Purpose:** Aggregate tax across FINALIZED documents

**Implementation:**
```python
@mcp.tool()
def calculate_tax_summary(userId: str, accountantId: str) -> str:
    """Aggregate tax data with multi-tenant isolation."""
    # Queries GSI with status = "FINALIZED"
    # Filters: userId + recordType == "DOCUMENT"
    # Aggregates: sum(extractedTax)
    # Returns: totalTax, documentCount, dateRange
```

**Response:**
```json
{
  "userId": "user-456",
  "accountantId": "acct-789",
  "totalTax": 1250.50,
  "documentCount": 12,
  "dateRange": {
    "earliest": "2024-01-01",
    "latest": "2024-03-31"
  },
  "documents": [
    {
      "documentId": "doc-123",
      "vendor": "ABC Supplies",
      "tax": 150.0,
      "date": "2024-01-15"
    }
  ],
  "calculatedAt": "2024-03-20T14:32:00Z"
}
```

### Deployment: AccountMcp Server

#### Option A: AWS Lambda Deployment

1. **Package the function:**
   ```bash
   cd amplify/AccountAgents/app/AccountMcp
   pip install -r requirements.txt -t .
   zip -r mcp-server.zip .
   ```

2. **Create Lambda Function:**
   - Runtime: Python 3.11
   - Handler: `main.mcp.run`
   - Memory: 256 MB
   - Timeout: 60 seconds

3. **Environment Variables:**
   ```
   DYNAMODB_TABLE_NAME=DocumentRecord
   AWS_REGION=us-east-1
   ```

4. **IAM Role Policy:**
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": [
           "dynamodb:GetItem",
           "dynamodb:Query"
         ],
         "Resource": "arn:aws:dynamodb:us-east-1:*:table/DocumentRecord*"
       }
     ]
   }
   ```

5. **API Gateway Setup:**
   - Create REST API endpoint
   - POST method pointing to Lambda
   - CORS enabled for frontend calls

#### Option B: Docker/ECS Deployment

1. **Create Dockerfile:**
   ```dockerfile
   FROM python:3.11-slim
   WORKDIR /app
   COPY requirements.txt .
   RUN pip install -r requirements.txt
   COPY main.py .
   EXPOSE 8000
   CMD ["python", "main.py"]
   ```

2. **Build and push:**
   ```bash
   docker build -t accountmcp:latest .
   docker tag accountmcp:latest 123456789.dkr.ecr.us-east-1.amazonaws.com/accountmcp:latest
   docker push 123456789.dkr.ecr.us-east-1.amazonaws.com/accountmcp:latest
   ```

3. **ECS Task Definition:**
   - Container port: 8000
   - Environment variables as above
   - CloudWatch logging

### Testing AccountMcp Server

**Local Testing:**
```bash
cd amplify/AccountAgents/app/AccountMcp
export DYNAMODB_TABLE_NAME=DocumentRecord
export AWS_REGION=us-east-1
python main.py
```

**Tool Invocation Test:**
```bash
curl -X POST http://localhost:8000/tools/get_document_details \
  -H "Content-Type: application/json" \
  -d '{
    "documentId": "doc-123",
    "userId": "user-456",
    "accountantId": "acct-789"
  }'
```

---

## Phase 3: Bedrock Agent Configuration

### Files Created

1. **`agent-config.json`** - Agent definition and tool registration
2. **`system-prompt.md`** - Financial compliance instructions

### Agent Setup

#### Via AWS Console

1. Go to **AWS Bedrock** → **Agents** → **Create Agent**

2. **General Settings:**
   - Name: `AccountAi-Financial-Compliance-Agent`
   - Model: `us.anthropic.claude-3-5-sonnet-20241022`
   - Max Tokens: 4096
   - Temperature: 0.3 (precise, non-speculative)

3. **System Prompt:**
   - Paste content from `system-prompt.md`

4. **Register Tools:**
   - Type: MCP
   - Endpoint: `https://<LAMBDA_URL>/mcp` or `http://accountmcp-service:8000/mcp`
   - Tools: 
     - `get_document_details`
     - `list_client_documents`
     - `calculate_tax_summary`

5. **Action Group:**
   - Name: `AccountMcp`
   - Description: "Access to multi-tenant document data"

6. **Agent Alias:**
   - Create alias for production (e.g., "v1-prod")
   - Test in sandbox before promoting

#### Via AWS CLI

```bash
aws bedrock-agent create-agent \
  --agent-name "AccountAi-Financial-Compliance-Agent" \
  --agent-resource-role-arn "arn:aws:iam::ACCOUNT:role/BedrockAgentRole" \
  --foundation-model "us.anthropic.claude-3-5-sonnet-20241022" \
  --instruction "You are a Financial Compliance Assistant..." \
  --region us-east-1
```

---

## Phase 4: Integration with Frontend Gateway

### Lambda Gateway Handler

The frontend calls `VITE_BEDROCK_AGENT_GATEWAY_URL` which should be a Lambda function that:

1. **Authenticates Request:**
   - Validates Cognito token
   - Extracts `userId` from token
   - Verifies `accountantId` from request body matches token

2. **Enriches Context:**
   ```python
   enriched_context = {
     "prompt": request.body["prompt"],
     "userId": token_payload["sub"],
     "accountantId": request.body["accountantId"],
     "documentId": request.body["documentId"],
     "sessionId": request.body["sessionId"]
   }
   ```

3. **Invokes Bedrock Agent:**
   ```python
   response = bedrock_agent.invoke_agent(
     agentId="AGENT_ID",
     agentAliasId="ALIAS_ID",
     sessionId=enriched_context["sessionId"],
     inputText=enriched_context["prompt"]
   )
   ```

4. **Streams Response:**
   - Parses agent streaming output
   - Returns via SSE or JSON to ChatAssistant
   - Includes thinking blocks (optional)

### Environment Variables (Frontend)

Set in `.env.local` or `.env.production`:

```
VITE_BEDROCK_AGENT_GATEWAY_URL=https://api.example.com/bedrock/invoke
VITE_AWS_REGION=us-east-1
VITE_AWS_USER_POOL_ID=us-east-1_xxxxx
```

---

## Multi-Tenant Isolation Verification

### Security Checklist

- [ ] ChatAssistant component requires `accountantId` prop
- [ ] Session ID includes `accountantId`: `doc_session_{accountantId}_{userId}_{documentId}`
- [ ] Every fetch to gateway includes `accountantId` in request body
- [ ] Every tool call includes both `accountantId` AND `userId` parameters
- [ ] `get_document_details` validates document.accountantId == parameter.accountantId
- [ ] `list_client_documents` filters by userId (not just GSI accountantId)
- [ ] `calculate_tax_summary` filters by userId (not just GSI accountantId)
- [ ] Gateway Lambda validates token matches accountantId
- [ ] DynamoDB queries use GSI (no table scans)
- [ ] No customer data visible across different accountantIds

### Test Cases

**Test 1: Same Customer, Different Accountant**
```
Request 1: accountantId=acct-001, userId=user-001, documentId=doc-001
Request 2: accountantId=acct-002, userId=user-001, documentId=doc-001

Expected: Request 2 returns "Access denied" or empty documents
```

**Test 2: Wrong Accountant**
```
Request: get_document_details(
  documentId="doc-001",    # Belongs to acct-001
  userId="user-001",
  accountantId="acct-002"  # Wrong accountant
)

Expected: {
  "error": "Access denied: Document does not belong to this accountant or user"
}
```

**Test 3: Tax Aggregation Isolation**
```
Query: calculate_tax_summary(userId="user-001", accountantId="acct-001")
Query: calculate_tax_summary(userId="user-001", accountantId="acct-002")

Expected: Different totalTax and document lists
```

---

## Troubleshooting

### Issue: "Tool not found" error from Bedrock

**Solution:**
- Verify MCP endpoint is reachable from Bedrock
- Check tool names exactly match in agent config
- Ensure Lambda/ECS has IAM permissions for DynamoDB

### Issue: "Access denied" for valid documents

**Solution:**
- Check document.accountantId matches request parameter
- Verify DynamoDB table has GSI: `accountantId-status-index`
- Confirm boto3 credentials have DynamoDB query permissions

### Issue: Frontend shows "Unable to reach Bedrock Agent"

**Solution:**
- Check GATEWAY_URL environment variable is set
- Verify gateway Lambda is deployed and responding
- Check Cognito token is valid (not expired)
- Review Lambda CloudWatch logs for errors

### Issue: ChatAssistant component doesn't render

**Solution:**
- Verify all three props are passed: `documentId`, `userId`, `accountantId`
- Check TypeScript compilation: `npm run build`
- Review browser console for component errors

---

## Performance Optimization

### DynamoDB Query Optimization

- **GSI Usage**: All queries use `accountantId-status-index` (no table scans)
- **Query Cost**: O(k) where k = documents for accountantId
- **Batch Operations**: None required (single customer per request)

### Caching Strategy

**Optional**: Add Redis caching for:
- `list_client_documents` results (5-minute TTL)
- `calculate_tax_summary` results (1-hour TTL)
- Cache key: `{accountantId}:{userId}:{operation}`

### Async Processing

For large document collections (100+):
- Use `calculate_tax_summary` with date range filtering
- Split queries by month/quarter
- Cache aggregated results

---

## Security Considerations

### Data Protection

1. **In Transit:**
   - HTTPS only (all endpoints)
   - API Gateway with WAF
   - Cognito token validation

2. **At Rest:**
   - DynamoDB encryption enabled
   - S3 bucket with encryption
   - Sensitive fields masked in logs

3. **Access Control:**
   - IAM roles scoped to specific operations
   - Lambda execution role limited to DynamoDB
   - No cross-account access

### Audit Logging

Enable CloudWatch logging for:
- Gateway Lambda invocations (requestId, userId, accountantId)
- DynamoDB queries (accountantId filter usage)
- Agent tool calls (prompt content, tool parameters)

---

## Deployment Checklist

- [ ] Frontend compiled successfully (`npm run build`)
- [ ] AccountMcp server deployed to Lambda/ECS
- [ ] DynamoDB table verified with GSI
- [ ] Bedrock agent created and tested
- [ ] Gateway Lambda deployed with multi-tenant validation
- [ ] Environment variables configured
- [ ] CORS enabled on API Gateway
- [ ] IAM roles assigned correctly
- [ ] Security tests passed
- [ ] Load testing completed
- [ ] Team trained on architecture
- [ ] Monitoring and alerts configured

---

## References

- **EWA Reference**: MCP pattern for FastMCP + Bedrock
- **Bedrock Agents**: https://docs.aws.amazon.com/bedrock/latest/userguide/agents.html
- **FastMCP**: https://github.com/Spartan737/FastMCP
- **DocumentRecord Schema**: `amplify/data/resource.ts`

---

**Version**: 1.0.0  
**Last Updated**: 2024  
**Status**: Ready for Deployment
