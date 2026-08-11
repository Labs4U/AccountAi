# Account AI Core Architecture & Behavior

## Overview
This specification dictates the core architecture, behavior, and boundaries for the Account AI platform. As an AI assistant, you must adhere strictly to these rules: skip all greetings, apologies, and conversational filler. Output only the requested code, terminal commands, or direct technical answers. Do not improvise extra features; stick strictly to the document outlines, schemas, and prompts provided. Provide complete, runnable code blocks without using placeholders.

## Architecture
* **Frontend:** React, TypeScript, AWS Amplify Gen 2.
* **Backend / Serverless:** AWS AppSync (Primary Data Access Layer), DynamoDB, Lambda, Amazon Bedrock, Model Context Protocol (MCP).
* **CLI/Framework:** AWS AgentCore (Monorepo structure).
* **Python Environments:** `uv` for package management, `boto3` for all AWS service interactions.
* **Native AWS ONLY:** Rely entirely on native AWS infrastructure tools and AI Agents. Explicitly exclude n8n or any other third-party workflow automation services from all designs.
* **Regional Constraints:** Account for regional service availability (e.g., Amazon Connect is not available in the UAE).

## Components and Interfaces
* **AppSync API First:** Use AppSync for all frontend-to-database interactions instead of direct DynamoDB table access. Frontend components must use the Amplify Gen 2 Data client (`client.models...`).
* **UI / UX Layouts:** Use docked side-panels and split-screen flex layouts over modal popups for data-heavy triage workflows to maintain data visibility.
* **Voice-First Input:** When designing AI interaction components (like Chat Assistants), utilize a multimodal voice control interface instead of a standard text input setup.

## Data Models
* **Single-Table Design Profiles:** Utilize `documentId: "ACC"` for Accountant profiles and `documentId: "CUST"` for Customer profiles to maintain an optimized schema.
* **Strictly Indexed Queries (Zero Table Scans):** All queries MUST be built up on defined Global Secondary Indexes (GSIs). Never write `.list({ filter: {} })` queries or operations that result in full DynamoDB table scans. If a query requires a specific access pattern, a secondary index must be declared in the schema first.

## Correctness Properties
* **Multi-Tenant Security:** Every database query, mutation, and MCP tool MUST enforce strict data isolation. Utilize Cognito SUBs (`userId` for customers, `accountantId` for assigned triage staff) to ensure cross-tenant data leakage is structurally impossible.

## Error Handling
* **AppSync GraphQL Rejections:** Frontend mutations must explicitly check for `response.errors`. If present, execution must halt, errors must be logged, and UI success popups must be blocked.
* **UI State Validation:** Submit buttons in setup forms must remain strictly disabled (inactive) until all required fields are validated and populated.