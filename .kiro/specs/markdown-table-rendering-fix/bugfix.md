# Bugfix Requirements Document

## Introduction

Markdown tables returned by the Bedrock Agent are not rendering as HTML `<table>` elements inside the `ChatAssistant` component. Instead, users see raw pipe-delimited text strings such as `| Document ID | Status | Amount |`. This degrades readability for all agent responses that include tabular financial data (document listings, tax summaries, vendor breakdowns, etc.).

The root causes are two stream-processing issues: the LLM stream omits the blank line that remark-gfm requires before a table header, and newlines between pipe characters are sometimes lost during streaming, causing rows to be squashed into a single line. Additionally, the `.markdown-body` CSS block lacks table element styles, so even a correctly-parsed table would render without borders or structured layout.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN the Bedrock Agent response contains a markdown table and no blank line precedes the table header row THEN the system renders the table as raw pipe-delimited text instead of an HTML table element.

1.2 WHEN the Bedrock Agent response stream loses newline characters between pipe characters of consecutive table rows THEN the system squashes multiple rows into a single line of raw text.

1.3 WHEN a markdown table is present in an agent message THEN the system displays no visible table borders, column headers, or alternating row styles because `.markdown-body` has no table CSS rules.

### Expected Behavior (Correct)

2.1 WHEN the Bedrock Agent response contains a markdown table and no blank line precedes the table header row THEN the system SHALL insert the required blank line before the table block so that remark-gfm parses it as a table.

2.2 WHEN the Bedrock Agent response stream has lost newline characters between consecutive pipe-delimited rows THEN the system SHALL restore the missing newlines between rows so that each table row is on its own line.

2.3 WHEN a correctly-parsed markdown table is rendered inside `.markdown-body` THEN the system SHALL display it as a styled HTML table with visible borders, a distinct header row, and readable row spacing.

### Unchanged Behavior (Regression Prevention)

3.1 WHEN a message contains only plain prose text (no pipe characters) THEN the system SHALL CONTINUE TO render it as normal markdown paragraphs without modification.

3.2 WHEN a message contains inline code or code blocks THEN the system SHALL CONTINUE TO render them correctly without alteration from the pre-processor.

3.3 WHEN a message contains markdown lists, bold text, italic text, or headings THEN the system SHALL CONTINUE TO render them correctly without alteration.

3.4 WHEN the user sends a message or the session is stored or restored from sessionStorage THEN the system SHALL CONTINUE TO preserve and display messages identically, without data loss or corruption.

3.5 WHEN the Bedrock Agent is invoked with `prompt`, `sessionId`, `accountantId`, `customerId`, and `documentId` parameters THEN the system SHALL CONTINUE TO pass those parameters unchanged.

3.6 WHEN Cognito IDs (`accountantId`, `customerId`) are used to build the `sessionId` or `storageKey` THEN the system SHALL CONTINUE TO use them without modification.
