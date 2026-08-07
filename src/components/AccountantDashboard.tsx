import { useEffect, useState } from "react";
import type { Schema } from "../../amplify/data/resource";
import { generateClient } from "aws-amplify/data";

const client = generateClient<Schema>();

export default function AccountantDashboard() {
  const [documents, setDocuments] = useState<Array<Schema["DocumentRecord"]["type"]>>([]);

  useEffect(() => {
    // Admin group has global read access. Fetching all docs requiring attention.
    const subscription = client.models.DocumentRecord.observeQuery({
      filter: {
        or: [
          { status: { eq: "CUSTOMER_APPROVED_FLAGGED" } },
          { status: { eq: "CUSTOMER_APPROVED_CLEAN" } },
          { status: { eq: "ACCOUNTANT_REVIEW" } }
        ]
      }
    }).subscribe({
      next: (data) => setDocuments([...data.items]),
      error: (err) => console.error("Admin subscription error:", err),
    });
    return () => subscription.unsubscribe();
  }, []);

  const startReview = async (doc: Schema["DocumentRecord"]["type"]) => {
    try {
      await client.models.DocumentRecord.update({
        userId: doc.userId,
        documentId: doc.documentId,
        status: "ACCOUNTANT_REVIEW" // This locks the customer out of editing
      });
    } catch (err) {
      console.error("Lock error", err);
    }
  };

  const finalizeDocument = async (doc: Schema["DocumentRecord"]["type"]) => {
    try {
      await client.models.DocumentRecord.update({
        userId: doc.userId,
        documentId: doc.documentId,
        status: "FINALIZED"
      });
      alert(`Document ${doc.documentId} finalized for ledger!`);
    } catch (err) {
      console.error("Finalize error", err);
    }
  };

  return (
    <main className="content">
      <h2>Accountant Compliance Triage</h2>
      <p>Documents approved by customers awaiting final COA validation and lock.</p>

      {documents.length === 0 ? (
        <div className="empty-state">No pending documents to review.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem", marginTop: "2rem" }}>
          {documents.map((doc) => (
            <div key={doc.documentId} className="card" style={{ borderLeft: doc.status === "CUSTOMER_APPROVED_FLAGGED" ? "4px solid #ed6c02" : "4px solid #1976d2" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "1rem" }}>
                <div>
                  <strong>Customer SUB:</strong> <code style={{ fontSize: "0.8rem" }}>{doc.userId}</code><br/>
                  <strong>Doc ID:</strong> {doc.documentId}
                </div>
                <span className="badge" style={{ backgroundColor: doc.status === "ACCOUNTANT_REVIEW" ? "#9c27b0" : "#333", color: "#fff" }}>
                  {doc.status}
                </span>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", background: "#f8f9fa", padding: "1rem", borderRadius: "4px" }}>
                <div>
                  <p><strong>Vendor:</strong> {doc.extractedVendor}</p>
                  <p><strong>Date:</strong> {doc.extractedDate}</p>
                  <p><strong>TRN:</strong> {doc.vendorTRN}</p>
                </div>
                <div>
                  <p><strong>Total:</strong> ${doc.extractedTotal}</p>
                  <p><strong>Tax (VAT):</strong> ${doc.extractedTax}</p>
                  <p>
                    <strong>Proposed COA:</strong> {doc.mappedAccountCode} - {doc.mappedAccountName}
                  </p>
                </div>
              </div>

              <div style={{ marginTop: "1rem", display: "flex", gap: "1rem" }}>
                {doc.status !== "ACCOUNTANT_REVIEW" ? (
                  <button className="secondary-btn" onClick={() => startReview(doc)}>
                    Lock & Start Review
                  </button>
                ) : (
                  <>
                    <button className="primary-btn">Ask AI Agent (MCP)</button>
                    <button className="success-btn" onClick={() => finalizeDocument(doc)}>
                      Approve & Finalize
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}