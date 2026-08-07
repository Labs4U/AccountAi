import { useEffect, useState } from "react";
import type { Schema } from "../../amplify/data/resource";
import { generateClient } from "aws-amplify/data";
import { getCurrentUser, fetchAuthSession } from "aws-amplify/auth";
import { uploadData } from "aws-amplify/storage";

const client = generateClient<Schema>();

export default function CustomerPortal() {
  const [activeTab, setActiveTab] = useState<"dashboard" | "inbox" | "upload" | "library">("inbox");
  const [documents, setDocuments] = useState<Array<Schema["DocumentRecord"]["type"]>>([]);
  const [isUploading, setIsUploading] = useState(false);

  useEffect(() => {
    // Only fetches documents where the userId matches the logged-in customer
    const subscription = client.models.DocumentRecord.observeQuery().subscribe({
      next: (data) => setDocuments([...data.items]),
      error: (err) => console.error("Subscription error:", err),
    });
    return () => subscription.unsubscribe();
  }, []);

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    try {
      // 1. Get the Cognito SUB (User ID) directly from the auth session
      const session = await fetchAuthSession();
      const userSub = session.tokens?.idToken?.payload.sub;
      
      if (!userSub) {
        throw new Error("Could not retrieve user SUB from session.");
      }

      // 2. Safely extract extension and create Document ID
      const documentId = `doc-${Date.now()}`;
      const parts = file.name.split(".");
      const fileExtension = parts.length > 1 ? parts.pop() : "jpg";

      // 3. Construct the exact multi-tenant path
      const exactS3Path = `${userSub}/raw/${documentId}.${fileExtension}`;
      console.log("Uploading to exact path:", exactS3Path);

      // 4. Upload using the explicit string path
      const uploadOperation = uploadData({
        path: exactS3Path,
        data: file,
      });

      const result = await uploadOperation.result;
      
      // 5. Create DynamoDB record tying the SUB to the file
      await client.models.DocumentRecord.create({
        userId: userSub.toString(),
        documentId: documentId,
        status: "PROCESSING", 
        s3RawUri: `s3://account-ai-bh/${result.path}`,
      });

      alert(`Document uploaded and sent to AI pipeline!`);
      setActiveTab("inbox");
    } catch (err: any) {
      console.error("Upload error:", err);
      alert(`Failed to upload document: ${err.message || JSON.stringify(err)}`);
    } finally {
      setIsUploading(false);
    }
  };

  const handleValidateExtraction = async (
    doc: Schema["DocumentRecord"]["type"],
    finalData: { vendorName: string; total: string; tax: string; date: string }
  ) => {
    try {
      const newStatus = (doc.aiConfidenceScore ?? 100) < 90 || !doc.isMathValid 
        ? "CUSTOMER_APPROVED_FLAGGED" 
        : "CUSTOMER_APPROVED_CLEAN";

      await client.models.DocumentRecord.update({
        userId: doc.userId,
        documentId: doc.documentId,
        status: newStatus, 
        extractedVendor: finalData.vendorName,
        extractedTotal: finalData.total ? parseFloat(finalData.total) : null,
        extractedTax: finalData.tax ? parseFloat(finalData.tax) : null,
        extractedDate: finalData.date || null,
      });

      alert(`Data approved! Sent to Accountant queue.`);
    } catch (err) {
      console.error("Validation error:", err);
    }
  };

  const pendingDocs = documents.filter((d) => d.status === "PENDING_CUSTOMER");

  return (
    <main className="content">
      <nav className="nav-tabs">
        <button className={activeTab === "inbox" ? "active-tab-btn" : "tab-btn"} onClick={() => setActiveTab("inbox")}>
          📥 Action Required ({pendingDocs.length})
        </button>
        <button className={activeTab === "upload" ? "active-tab-btn" : "tab-btn"} onClick={() => setActiveTab("upload")}>
          📤 Upload Document
        </button>
        <button className={activeTab === "library" ? "active-tab-btn" : "tab-btn"} onClick={() => setActiveTab("library")}>
          📁 My Library ({documents.length})
        </button>
      </nav>

      {activeTab === "upload" && (
        <div className="upload-box" style={{ marginTop: "2rem" }}>
          <h2>Upload Financial Document</h2>
          <input type="file" accept="application/pdf,image/*" onChange={handleFileUpload} disabled={isUploading} />
          {isUploading && <p>Processing upload...</p>}
        </div>
      )}

      {activeTab === "inbox" && (
        <div style={{ marginTop: "2rem" }}>
          <h2>Documents Awaiting Your Review</h2>
          {pendingDocs.length === 0 ? <p>You are all caught up!</p> : (
            pendingDocs.map((doc) => (
              <div key={doc.documentId} className="card" style={{ marginBottom: "1rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <strong>ID: {doc.documentId}</strong>
                  <span className="badge">{doc.status}</span>
                </div>
                
                {doc.isMathValid === false && (
                  <div style={{ backgroundColor: "#ffebee", color: "#c62828", padding: "0.75rem", borderRadius: "4px", margin: "1rem 0" }}>
                    ⚠️ AI Warning: Mathematical discrepancy detected (Subtotal + Tax != Total).
                  </div>
                )}

                <form onSubmit={(e) => {
                  e.preventDefault();
                  const formData = new FormData(e.currentTarget);
                  handleValidateExtraction(doc, {
                    vendorName: formData.get("vendorName") as string,
                    total: formData.get("total") as string,
                    tax: formData.get("tax") as string,
                    date: formData.get("date") as string,
                  });
                }}>
                  <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", marginTop: "1rem" }}>
                    <div className="form-group">
                      <label>Vendor {(doc.aiConfidenceScore ?? 100) < 90 && "⚠️"}</label>
                      <input name="vendorName" defaultValue={doc.extractedVendor || ""} className="input" />
                    </div>
                    <div className="form-group">
                      <label>Total {(doc.aiConfidenceScore ?? 100) < 90 && "⚠️"}</label>
                      <input name="total" type="number" step="0.01" defaultValue={doc.extractedTotal || ""} className="input" />
                    </div>
                    <div className="form-group">
                      <label>Tax</label>
                      <input name="tax" type="number" step="0.01" defaultValue={doc.extractedTax || ""} className="input" />
                    </div>
                  </div>
                  <button type="submit" className="success-btn" style={{ marginTop: "1rem" }}>Approve & Send to Accountant</button>
                </form>
              </div>
            ))
          )}
        </div>
      )}

      {activeTab === "library" && (
        <div style={{ marginTop: "2rem" }}>
          <h2>My Document History</h2>
          <table className="table" style={{ width: "100%", textAlign: "left", marginTop: "1rem" }}>
            <thead>
              <tr style={{ background: "#f5f5f5" }}>
                <th>ID</th>
                <th>Vendor</th>
                <th>Total</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => (
                <tr key={doc.documentId} style={{ borderBottom: "1px solid #eee" }}>
                  <td>{doc.documentId}</td>
                  <td>{doc.extractedVendor || "Processing..."}</td>
                  <td>{doc.extractedTotal ? `$${doc.extractedTotal}` : "-"}</td>
                  <td><span className="badge">{doc.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

