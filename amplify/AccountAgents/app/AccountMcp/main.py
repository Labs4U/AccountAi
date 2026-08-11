"""
AccountAi Multi-Tenant MCP Server
Provides DynamoDB access tools for the Bedrock Financial Compliance Agent
Enforces multi-tenant isolation at every query layer.
"""

import os
import json
import boto3
from datetime import datetime
from decimal import Decimal
from fastmcp import FastMCP

# ──────────────────────────────────────────────────────────────────────────────
# Initialize FastMCP and DynamoDB Client
# ──────────────────────────────────────────────────────────────────────────────

mcp = FastMCP("AccountAi_DynamoDB_Server")

# Get DynamoDB table name from environment (set by Amplify backend)
DYNAMODB_TABLE_NAME = os.getenv("DYNAMODB_TABLE_NAME", "DocumentRecord")
REGION = os.getenv("AWS_REGION", "us-east-1")

dynamodb = boto3.resource("dynamodb", region_name=REGION)
table = dynamodb.Table(DYNAMODB_TABLE_NAME)


# ──────────────────────────────────────────────────────────────────────────────
# Helper Functions
# ──────────────────────────────────────────────────────────────────────────────

def serialize_decimal(obj):
    """Convert Decimal objects to float for JSON serialization."""
    if isinstance(obj, Decimal):
        return float(obj)
    if isinstance(obj, dict):
        return {k: serialize_decimal(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [serialize_decimal(i) for i in obj]
    return obj


def validate_tenant_context(accountantId: str, userId: str) -> None:
    """
    Validate that accountantId and userId are non-empty.
    Raises ValueError if validation fails.
    """
    if not accountantId or not accountantId.strip():
        raise ValueError("accountantId is required and cannot be empty")
    if not userId or not userId.strip():
        raise ValueError("userId is required and cannot be empty")


def validate_document_ownership(document: dict, accountantId: str, userId: str) -> bool:
    """
    Verify that a document belongs to the specified accountant and user.
    Returns True if ownership is valid, False otherwise.
    """
    if not document:
        return False
    return document.get("accountantId") == accountantId and document.get("userId") == userId


# ──────────────────────────────────────────────────────────────────────────────
# Tool 1: get_document_details
# ──────────────────────────────────────────────────────────────────────────────

@mcp.tool()
def get_document_details(documentId: str, userId: str, accountantId: str) -> str:
    """
    Fetch detailed metadata for a single document.
    
    Multi-tenant isolation:
    - Verifies document's accountantId matches the parameter
    - Verifies document's userId matches the parameter
    
    Returns JSON with extracted fields:
    - vendor, total, tax, date, status, mappedAccountCode, mappedAccountName
    """
    try:
        # 1. Validate multi-tenant context
        validate_tenant_context(accountantId, userId)
        
        # 2. Query DynamoDB using the primary key
        response = table.get_item(
            Key={
                "userId": userId,
                "documentId": documentId
            }
        )
        
        document = response.get("Item")
        if not document:
            return json.dumps({
                "error": "Document not found",
                "documentId": documentId,
                "userId": userId
            })
        
        # 3. Enforce multi-tenant isolation: verify accountantId matches
        if not validate_document_ownership(document, accountantId, userId):
            return json.dumps({
                "error": "Access denied: Document does not belong to this accountant or user",
                "documentId": documentId,
                "userId": userId,
                "accountantId": accountantId
            })
        
        # 4. Extract and return key fields
        result = {
            "documentId": document.get("documentId"),
            "userId": document.get("userId"),
            "accountantId": document.get("accountantId"),
            "vendor": document.get("extractedVendor"),
            "total": serialize_decimal(document.get("extractedTotal")),
            "tax": serialize_decimal(document.get("extractedTax")),
            "date": document.get("extractedDate"),
            "status": document.get("status"),
            "docType": document.get("docType"),
            "mappedAccountCode": document.get("mappedAccountCode"),
            "mappedAccountName": document.get("mappedAccountName"),
            "aiConfidenceScore": serialize_decimal(document.get("aiConfidenceScore")),
            "isMathValid": document.get("isMathValid"),
            "s3FinalUri": document.get("s3FinalUri"),
            "accountantNote": document.get("accountantNote")
        }
        
        return json.dumps(result)
    
    except ValueError as ve:
        return json.dumps({"error": str(ve)})
    except Exception as e:
        return json.dumps({
            "error": f"Failed to fetch document details: {str(e)}"
        })


# ──────────────────────────────────────────────────────────────────────────────
# Tool 2: list_client_documents
# ──────────────────────────────────────────────────────────────────────────────

@mcp.tool()
def list_client_documents(
    userId: str,
    accountantId: str,
    status: str = None
) -> str:
    """
    Fetch all documents for a specific customer assigned to this accountant.
    
    Uses GSI: listByAccountantAndStatus
    Multi-tenant isolation:
    - Filters by accountantId (GSI partition key)
    - Filters by userId (application-level filter)
    - Excludes profile records (filters recordType == "DOCUMENT")
    - Optionally filters by status
    
    Returns JSON array of documents with key fields.
    """
    try:
        # 1. Validate multi-tenant context
        validate_tenant_context(accountantId, userId)
        
        # 2. Query GSI: listByAccountantAndStatus
        query_params = {
            "IndexName": "accountantId-status-index",  # GSI name from schema
            "KeyConditionExpression": "accountantId = :accountantId",
            "ExpressionAttributeValues": {
                ":accountantId": accountantId
            }
        }
        
        # Optional status filter (uses GSI sort key)
        if status:
            query_params["KeyConditionExpression"] += " AND #status = :status"
            query_params["ExpressionAttributeValues"][":status"] = status
            query_params["ExpressionAttributeNames"] = {"#status": "status"}
        
        response = table.query(**query_params)
        
        # 3. Application-level filters: userId + recordType
        documents = []
        for item in response.get("Items", []):
            # Filter by userId (multi-tenant isolation)
            if item.get("userId") != userId:
                continue
            
            # Exclude profile records (only include DOCUMENT records)
            if item.get("recordType") != "DOCUMENT":
                continue
            
            # Build summary for each document
            doc_summary = {
                "documentId": item.get("documentId"),
                "userId": item.get("userId"),
                "accountantId": item.get("accountantId"),
                "vendor": item.get("extractedVendor"),
                "total": serialize_decimal(item.get("extractedTotal")),
                "tax": serialize_decimal(item.get("extractedTax")),
                "date": item.get("extractedDate"),
                "status": item.get("status"),
                "docType": item.get("docType"),
                "mappedAccountCode": item.get("mappedAccountCode"),
                "mappedAccountName": item.get("mappedAccountName")
            }
            documents.append(doc_summary)
        
        return json.dumps({
            "count": len(documents),
            "documents": documents,
            "userId": userId,
            "accountantId": accountantId,
            "statusFilter": status
        })
    
    except ValueError as ve:
        return json.dumps({"error": str(ve)})
    except Exception as e:
        return json.dumps({
            "error": f"Failed to list documents: {str(e)}"
        })


# ──────────────────────────────────────────────────────────────────────────────
# Tool 3: calculate_tax_summary
# ──────────────────────────────────────────────────────────────────────────────

@mcp.tool()
def calculate_tax_summary(userId: str, accountantId: str) -> str:
    """
    Aggregate tax data across all FINALIZED documents for a customer.
    
    Uses GSI: listByAccountantAndStatus
    Multi-tenant isolation:
    - Filters by accountantId (GSI partition key)
    - Filters by status = "FINALIZED" (GSI sort key)
    - Filters by userId (application-level filter)
    - Filters by recordType = "DOCUMENT" (excludes profiles)
    
    Returns JSON with:
    - totalTax: sum of extractedTax across all FINALIZED documents
    - documentCount: number of FINALIZED documents
    - dateRange: earliest to latest extractedDate
    - documents: list of contributing documents (for transparency)
    """
    try:
        # 1. Validate multi-tenant context
        validate_tenant_context(accountantId, userId)
        
        # 2. Query GSI for FINALIZED documents
        response = table.query(
            IndexName="accountantId-status-index",
            KeyConditionExpression="accountantId = :accountantId AND #status = :status",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={
                ":accountantId": accountantId,
                ":status": "FINALIZED"
            }
        )
        
        # 3. Application-level filters and aggregation
        total_tax = 0.0
        document_dates = []
        contributing_documents = []
        
        for item in response.get("Items", []):
            # Filter by userId (multi-tenant isolation)
            if item.get("userId") != userId:
                continue
            
            # Exclude profile records
            if item.get("recordType") != "DOCUMENT":
                continue
            
            # Accumulate tax
            extracted_tax = item.get("extractedTax")
            if extracted_tax:
                total_tax += float(serialize_decimal(extracted_tax))
            
            # Track dates for date range
            extracted_date = item.get("extractedDate")
            if extracted_date:
                document_dates.append(extracted_date)
            
            # Track contributing documents
            contributing_documents.append({
                "documentId": item.get("documentId"),
                "vendor": item.get("extractedVendor"),
                "tax": serialize_decimal(extracted_tax),
                "date": extracted_date
            })
        
        # 4. Calculate date range
        date_range = None
        if document_dates:
            sorted_dates = sorted(document_dates)
            date_range = {
                "earliest": sorted_dates[0],
                "latest": sorted_dates[-1]
            }
        
        # 5. Return aggregated summary
        result = {
            "userId": userId,
            "accountantId": accountantId,
            "totalTax": round(total_tax, 2),
            "documentCount": len(contributing_documents),
            "dateRange": date_range,
            "documents": contributing_documents,
            "calculatedAt": datetime.utcnow().isoformat() + "Z"
        }
        
        return json.dumps(result)
    
    except ValueError as ve:
        return json.dumps({"error": str(ve)})
    except Exception as e:
        return json.dumps({
            "error": f"Failed to calculate tax summary: {str(e)}"
        })


# ──────────────────────────────────────────────────────────────────────────────
# Start the MCP Server
# ──────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    # Run as HTTP streamable server (for Bedrock Agent integration)
    mcp.run(transport="streamable-http")
