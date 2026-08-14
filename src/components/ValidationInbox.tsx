import { useEffect, useState } from "react";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "../../amplify/data/resource";

const client = generateClient<Schema>();

interface ValidationInboxProps {
  /** The accountant's Cognito SUB. Required to query via the
   * listByAccountantAndStatus GSI instead of performing a table scan. */
  accountantId: string;
}

export default function ValidationInbox({ accountantId }: ValidationInboxProps) {
  const [pendingDocs, setPendingDocs] = useState<Array<Schema["DocumentRecord"]["type"]>>([]);
  const [indexError, setIndexError] = useState<string | null>(null);

  useEffect(() => {
    if (!accountantId) return;

    // ─────────────────────────────────────────────────────────────────────────
    // FIX 1: We swap observeQuery for the dedicated index query to avoid 
    // table scans and bypass the index resolution errors.
    // ─────────────────────────────────────────────────────────────────────────
    const fetchPendingDocs = async () => {
      try {
        const { data, errors } = await client.models.DocumentRecord.listByAccountantAndStatus({
          accountantId: accountantId,
          status: { eq: "PENDING_CLASS" }
        });

        if (errors) {
          console.error("GraphQL Errors:", errors);
          setIndexError("Failed to fetch documents from the index.");
        } else {
          setPendingDocs(data);
          setIndexError(null);
        }
      } catch (err: any) {
        const msg: string = err?.message ?? String(err);
        if (msg.includes("ResourceNotFoundException") || msg.includes("Index")) {
          setIndexError(
            "GSI 'documentRecordsByAccountantIdAndStatus' not found or Access Denied. " +
            "Ensure the Amplify backend is deployed and IAM policies allow index querying."
          );
        }
        console.error("ValidationInbox fetch error:", err);
      }
    };

    // Initial fetch
    fetchPendingDocs();

    // Set up a 5-second polling interval to mimic the real-time nature of observeQuery
    // without triggering the table-scan bug.
    const intervalId = setInterval(fetchPendingDocs, 5000);
    return () => clearInterval(intervalId);
  }, [accountantId]);

  async function confirmClassification(
    doc: Schema["DocumentRecord"]["type"],
    confirmedType: string
  ) {
    try {
      // ─────────────────────────────────────────────────────────────────────────
      // FIX 2: Explicitly stamp the accountantId into the record during update
      // ─────────────────────────────────────────────────────────────────────────
      await client.models.DocumentRecord.update({
        userId: doc.userId,
        documentId: doc.documentId,
        docType: confirmedType,
        status: "PENDING_EXTRACTION",
        accountantId: accountantId, // <-- CRITICAL: This ties the document to the accountant
      });
      
      alert(`Document ${doc.documentId} classified as ${confirmedType}`);
      
      // Optimistically remove the document from the UI list
      setPendingDocs(prev => prev.filter(d => d.documentId !== doc.documentId));
    } catch (e) {
      console.error("Update failed:", e);
      alert("Failed to update document status. Check console for details.");
    }
  }

  if (!accountantId) {
    return (
      <section style={{ padding: "1rem", border: "1px solid #ccc", marginTop: "2rem" }}>
        <p style={{ color: "#64748b" }}>Loading accountant context…</p>
      </section>
    );
  }

  return (
    <section style={{ padding: "1rem", border: "1px solid #ccc", marginTop: "2rem" }}>
      <h2>Action Required: Classification Validation</h2>

      {indexError && (
        <div style={{ backgroundColor: "#fef2f2", border: "1px solid #fca5a5", padding: "1rem", borderRadius: "6px", marginBottom: "1rem", color: "#991b1b" }}>
          <strong>⚠️ Index Error:</strong> {indexError}
        </div>
      )}

      {pendingDocs.length === 0 && !indexError ? (
        <p>No documents waiting for validation.</p>
      ) : null}

      <ul>
        {pendingDocs.map((doc) => (
          <li key={doc.documentId} style={{ marginBottom: "1rem" }}>
            <p><strong>Document ID:</strong> {doc.documentId}</p>
            <p><strong>Proposed Type:</strong> {doc.docType}</p>

            <div style={{ display: "flex", gap: "10px" }}>
              <button onClick={() => confirmClassification(doc, "INVOICE")}>Confirm Invoice</button>
              <button onClick={() => confirmClassification(doc, "RECEIPT")}>Confirm Receipt</button>
              <button onClick={() => confirmClassification(doc, "OTHER")}>Mark as Other</button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}