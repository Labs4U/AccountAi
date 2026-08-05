import { useEffect, useState } from "react";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "../../amplify/data/resource";

const client = generateClient<Schema>();

export default function ValidationInbox() {
  const [pendingDocs, setPendingDocs] = useState<Array<Schema["DocumentRecord"]["type"]>>([]);

  useEffect(() => {
    // Query the GSI for documents specifically waiting for classification
    const sub = client.models.DocumentRecord.observeQuery({
      filter: { status: { eq: "PENDING_CLASS" } }
    }).subscribe({
      next: (data) => setPendingDocs([...data.items]),
    });
    return () => sub.unsubscribe();
  }, []);

  async function confirmClassification(doc: Schema["DocumentRecord"]["type"], confirmedType: string) {
    // Update the database record
    await client.models.DocumentRecord.update({
      userId: doc.userId,
      documentId: doc.documentId,
      docType: confirmedType,
      status: "PENDING_EXTRACTION", // Move to the next state
    });

    // Note: Once Step Functions are wired up, you will also call an API here 
    // to send the stepFunctionTaskToken back to AWS to resume the workflow.
    alert(`Document ${doc.documentId} classified as ${confirmedType}`);
  }

  return (
    <section style={{ padding: "1rem", border: "1px solid #ccc", marginTop: "2rem" }}>
      <h2>Action Required: Classification Validation</h2>
      {pendingDocs.length === 0 ? <p>No documents waiting for validation.</p> : null}
      
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