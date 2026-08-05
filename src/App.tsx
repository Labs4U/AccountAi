import { useEffect, useState } from "react";
import type { Schema } from "../amplify/data/resource";
import { generateClient } from "aws-amplify/data";
import { Authenticator } from "@aws-amplify/ui-react";
import { getCurrentUser } from "aws-amplify/auth";
import "@aws-amplify/ui-react/styles.css";
import { uploadData } from "aws-amplify/storage";



interface ExtractedExpenseData {
  vendorName?: string;
  total?: number;
  tax?: number;
  date?: string;
  confidenceScores?: Record<string, number>;
}
const client = generateClient<Schema>();

export default function App() {
  const [activeTab, setActiveTab] = useState<"dashboard" | "inbox" | "upload" | "library">("dashboard");
  const [documents, setDocuments] = useState<Array<Schema["DocumentRecord"]["type"]>>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("ALL");

  // 1. Real-time Subscription to User's Document Records in DynamoDB
  useEffect(() => {
    const subscription = client.models.DocumentRecord.observeQuery().subscribe({
      next: (data) => setDocuments([...data.items]),
      error: (err) => console.error("Subscription error:", err),
    });
    return () => subscription.unsubscribe();
  }, []);

  // 2. Metrics Aggregation
  const metrics = {
    total: documents.length,
    completed: documents.filter((d) => d.status === "COMPLETED").length,
    pendingClass: documents.filter((d) => d.status === "PENDING_CLASS").length,
    pendingExtract: documents.filter((d) => d.status === "PENDING_EXTRACTION").length,
    invoices: documents.filter((d) => d.docType === "INVOICE").length,
    receipts: documents.filter((d) => d.docType === "RECEIPT").length,
    others: documents.filter((d) => d.docType === "OTHER").length,
  };

  // 3. Document Search & Category Filtering Logic
  const filteredDocuments = documents.filter((doc) => {
    const matchesSearch =
      doc.documentId.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (doc.s3RawUri && doc.s3RawUri.toLowerCase().includes(searchQuery.toLowerCase()));
    const matchesCategory = selectedCategory === "ALL" || doc.docType === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  // 4. File Upload Handler (Raw S3 Landing Zone)
  // 4. File Upload Handler (Raw S3 Landing Zone)
  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    try {
      // We still want the User Pool SUB for our DynamoDB partition key
      const currentUser = await getCurrentUser();
      const userSub = currentUser.userId;

      const documentId = `doc-${Date.now()}`;
      const fileExtension = file.name.split(".").pop();

      // 1. UPLOAD TO S3 USING THE IDENTITY ID INJECTION
      console.log("Uploading file to S3...");
      const uploadOperation = uploadData({
        // FIX: Use the callback syntax so Amplify injects the correct IAM Identity ID
        path: ({ identityId }) => `private/${identityId}/raw/${documentId}.${fileExtension}`,
        data: file,
      });

      // Wait for upload to finish and grab the exact path it used
      const result = await uploadOperation.result;
      console.log("File uploaded successfully to S3!", result.path);

      // 2. Construct the final S3 URI using the path returned from the upload
      const s3RawUri = `s3://account-ai-bh/${result.path}`;

      // 3. Create tracking item in DynamoDB
      await client.models.DocumentRecord.create({
        userId: userSub, // Keep using User Pool SUB for database tracking
        documentId: documentId,
        docType: "UNCLASSIFIED",
        status: "PENDING_CLASS",
        s3RawUri: s3RawUri,
      });

      alert(`Document ${documentId} uploaded successfully to raw landing zone!`);
      setActiveTab("inbox");
    } catch (err) {
      console.error("Upload error:", err);
      alert("Failed to upload file or create document record.");
    } finally {
      setIsUploading(false);
    }
  };

  // 5. Stage 1: Validate Classification Handler
  const handleValidateClassification = async (
    doc: Schema["DocumentRecord"]["type"],
    confirmedType: "INVOICE" | "RECEIPT" | "OTHER"
  ) => {
    try {
      const fileName = doc.s3RawUri?.split("/").pop();
      const newS3Uri = `s3://account-ai-bh/${doc.userId}/${confirmedType}/${fileName}`;

      await client.models.DocumentRecord.update({
        userId: doc.userId,
        documentId: doc.documentId,
        docType: confirmedType,
        s3RawUri: newS3Uri,
        status: "PENDING_EXTRACTION",
      });

      alert(`Document re-classified as ${confirmedType} and moved to category path.`);
    } catch (err) {
      console.error("Classification validation error:", err);
    }
  };

  // 6. Stage 2: Validate Data Extraction Handler
  const handleValidateExtraction = async (
    doc: Schema["DocumentRecord"]["type"],
    finalData: any
  ) => {
    try {
      await client.models.DocumentRecord.update({
        userId: doc.userId,
        documentId: doc.documentId,
        status: "COMPLETED",
        extractedData: finalData, // Persist the human-validated data
      });

      alert(`Extracted data approved! Document ${doc.documentId} finalized.`);
    } catch (err) {
      console.error("Extraction validation error:", err);
      alert("Failed to save the validated extraction data.");
    }
  };

  return (
    <Authenticator>
      {({ signOut, user }) => (
        <div style={styles.container}>
          {/* Header Bar */}
          <header style={styles.header}>
            <div>
              <h1 style={{ margin: 0, fontSize: "1.5rem" }}>AccountAI Document Portal</h1>
              <small style={{ color: "#666" }}>Multi-Tenant Expense & Intelligent Document Platform</small>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
              <span style={styles.userBadge}>{user?.signInDetails?.loginId || user?.username}</span>
              <button style={styles.secondaryBtn} onClick={signOut}>
                Sign Out
              </button>
            </div>
          </header>

          {/* Navigation Tabs */}
          <nav style={styles.navTabs}>
            <button
              style={activeTab === "dashboard" ? styles.activeTabBtn : styles.tabBtn}
              onClick={() => setActiveTab("dashboard")}
            >
              📊 Analytics Dashboard
            </button>
            <button
              style={activeTab === "inbox" ? styles.activeTabBtn : styles.tabBtn}
              onClick={() => setActiveTab("inbox")}
            >
              📥 HITL Inbox ({metrics.pendingClass + metrics.pendingExtract})
            </button>
            <button
              style={activeTab === "upload" ? styles.activeTabBtn : styles.tabBtn}
              onClick={() => setActiveTab("upload")}
            >
              📤 Upload Document
            </button>
            <button
              style={activeTab === "library" ? styles.activeTabBtn : styles.tabBtn}
              onClick={() => setActiveTab("library")}
            >
              📁 Document Library ({metrics.total})
            </button>
          </nav>

          <main style={styles.content}>
            {/* TAB 1: ANALYTICS DASHBOARD */}
            {activeTab === "dashboard" && (
              <div>
                <h2>Expense & Document Analytics</h2>

                {/* Metric Cards Grid */}
                <div style={styles.metricsGrid}>
                  <div style={styles.card}>
                    <h3>Total Documents</h3>
                    <p style={styles.metricVal}>{metrics.total}</p>
                  </div>
                  <div style={styles.card}>
                    <h3>Completed</h3>
                    <p style={{ ...styles.metricVal, color: "#2e7d32" }}>{metrics.completed}</p>
                  </div>
                  <div style={styles.card}>
                    <h3>Action Required</h3>
                    <p style={{ ...styles.metricVal, color: "#ed6c02" }}>
                      {metrics.pendingClass + metrics.pendingExtract}
                    </p>
                  </div>
                </div>

                {/* Category Distribution Chart */}
                <div style={{ ...styles.card, marginTop: "1.5rem" }}>
                  <h3>Document Categories Breakdown</h3>
                  <div style={styles.chartBarContainer}>
                    <div
                      style={{
                        ...styles.chartBarSegment,
                        width: `${metrics.total ? (metrics.invoices / metrics.total) * 100 : 0}%`,
                        backgroundColor: "#1976d2",
                      }}
                      title={`Invoices: ${metrics.invoices}`}
                    />
                    <div
                      style={{
                        ...styles.chartBarSegment,
                        width: `${metrics.total ? (metrics.receipts / metrics.total) * 100 : 0}%`,
                        backgroundColor: "#2e7d32",
                      }}
                      title={`Receipts: ${metrics.receipts}`}
                    />
                    <div
                      style={{
                        ...styles.chartBarSegment,
                        width: `${metrics.total ? (metrics.others / metrics.total) * 100 : 0}%`,
                        backgroundColor: "#ed6c02",
                      }}
                      title={`Others: ${metrics.others}`}
                    />
                  </div>

                  <div style={styles.chartLegend}>
                    <span>
                      <strong style={{ color: "#1976d2" }}>■</strong> Invoices ({metrics.invoices})
                    </span>
                    <span>
                      <strong style={{ color: "#2e7d32" }}>■</strong> Receipts ({metrics.receipts})
                    </span>
                    <span>
                      <strong style={{ color: "#ed6c02" }}>■</strong> Other ({metrics.others})
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* TAB 2: HITL VALIDATION INBOX */}
            {activeTab === "inbox" && (
              <div>
                <h2>Human-in-the-Loop Validation Inbox</h2>
                <p>Review AI classification proposals and verify parsed expense data before final persistence.</p>

                {documents.filter((d) => d.status !== "COMPLETED").length === 0 ? (
                  <div style={styles.emptyState}>🎉 All documents have been validated!</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
                    {documents
                      .filter((d) => d.status !== "COMPLETED")
                      .map((doc) => {
                        // Safely cast the generic JSON to our explicit interface
                        const parsedData = doc.extractedData as unknown as ExtractedExpenseData;

                        return (
                          <div key={doc.documentId} style={styles.card}>
                            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.5rem" }}>
                              <strong>ID: {doc.documentId}</strong>
                              <span style={styles.badge}>{doc.status}</span>
                            </div>

                            {/* Stage 1: Validate Classification */}
                            {doc.status === "PENDING_CLASS" && (
                              <div>
                                <p>
                                  AI Proposed Classification: <strong>{doc.docType || "Unclassified"}</strong>
                                </p>
                                <p style={{ fontSize: "0.85rem", color: "#666" }}>Confirm or correct the document category:</p>
                                <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
                                  <button
                                    style={styles.primaryBtn}
                                    onClick={() => handleValidateClassification(doc, "INVOICE")}
                                  >
                                    Confirm Invoice
                                  </button>
                                  <button
                                    style={styles.primaryBtn}
                                    onClick={() => handleValidateClassification(doc, "RECEIPT")}
                                  >
                                    Confirm Receipt
                                  </button>
                                  <button
                                    style={styles.secondaryBtn}
                                    onClick={() => handleValidateClassification(doc, "OTHER")}
                                  >
                                    Set as Other
                                  </button>
                                </div>
                              </div>
                            )}

                            {/* Stage 2: Validate Data Extraction */}
                            {doc.status === "PENDING_EXTRACTION" && (
                              <div style={styles.extractionFormBox}>
                                <p style={{ fontWeight: 600, marginBottom: "1rem", color: "#333" }}>
                                  Review Extracted Data:
                                </p>
                                <form
                                  onSubmit={(e) => {
                                    e.preventDefault();
                                    const formData = new FormData(e.currentTarget);
                                    const updatedData = {
                                      vendorName: formData.get("vendorName"),
                                      total: formData.get("total"),
                                      tax: formData.get("tax"),
                                      date: formData.get("date"),
                                    };
                                    handleValidateExtraction(doc, updatedData);
                                  }}
                                >
                                  <div style={styles.formGroup}>
                                    <label style={styles.label}>
                                      Vendor Name
                                      {(parsedData?.confidenceScores?.vendorName ?? 100) < 90 && (
                                        <span style={styles.warningText}> (Review: Low AI Confidence)</span>
                                      )}
                                    </label>
                                    <input
                                      name="vendorName"
                                      defaultValue={parsedData?.vendorName || ""}
                                      style={styles.input}
                                    />
                                  </div>

                                  <div style={{ display: "flex", gap: "1rem" }}>
                                    <div style={styles.formGroup}>
                                      <label style={styles.label}>
                                        Total Amount
                                        {(parsedData?.confidenceScores?.total ?? 100) < 90 && (
                                          <span style={styles.warningText}> ⚠️</span>
                                        )}
                                      </label>
                                      <input
                                        name="total"
                                        type="number"
                                        step="0.01"
                                        defaultValue={parsedData?.total || ""}
                                        style={styles.input}
                                      />
                                    </div>
                                    <div style={styles.formGroup}>
                                      <label style={styles.label}>
                                        Tax
                                        {(parsedData?.confidenceScores?.tax ?? 100) < 90 && (
                                          <span style={styles.warningText}> ⚠️</span>
                                        )}
                                      </label>
                                      <input
                                        name="tax"
                                        type="number"
                                        step="0.01"
                                        defaultValue={parsedData?.tax || ""}
                                        style={styles.input}
                                      />
                                    </div>
                                  </div>

                                  <div style={styles.formGroup}>
                                    <label style={styles.label}>
                                      Date
                                      {(parsedData?.confidenceScores?.date ?? 100) < 90 && (
                                        <span style={styles.warningText}> ⚠️</span>
                                      )}
                                    </label>
                                    <input
                                      name="date"
                                      type="text"
                                      placeholder="YYYY-MM-DD"
                                      defaultValue={parsedData?.date || ""}
                                      style={styles.input}
                                    />
                                  </div>

                                  <button type="submit" style={styles.successBtn}>
                                    Approve Extracted Data & Save
                                  </button>
                                </form>
                              </div>
                            )}
                          </div>
                        );
                      })}
                  </div>
                )}
              </div>
            )}

            {/* TAB 3: UPLOAD DOCUMENT */}
            {activeTab === "upload" && (
              <div>
                <h2>Upload Financial Document</h2>
                <div style={styles.uploadBox}>
                  <p>Select an Invoice or Receipt (PDF, PNG, JPEG)</p>
                  <input
                    type="file"
                    accept="application/pdf,image/png,image/jpeg"
                    onChange={handleFileUpload}
                    disabled={isUploading}
                  />
                  {isUploading && <p style={{ color: "#1976d2", marginTop: "1rem" }}>Uploading to encrypted user S3 folder...</p>}
                </div>
              </div>
            )}

            {/* TAB 4: DOCUMENT LIBRARY */}
            {activeTab === "library" && (
              <div>
                <h2>Document Library & History</h2>

                {/* Filters */}
                <div style={{ display: "flex", gap: "1rem", marginBottom: "1rem" }}>
                  <input
                    type="text"
                    placeholder="Search documents..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    style={styles.input}
                  />
                  <select
                    value={selectedCategory}
                    onChange={(e) => setSelectedCategory(e.target.value)}
                    style={styles.input}
                  >
                    <option value="ALL">All Categories</option>
                    <option value="INVOICE">Invoices</option>
                    <option value="RECEIPT">Receipts</option>
                    <option value="OTHER">Others</option>
                  </select>
                </div>

                {/* Document Table */}
                <table style={styles.table}>
                  <thead>
                    <tr style={{ background: "#f5f5f5", textAlign: "left" }}>
                      <th style={styles.th}>Document ID</th>
                      <th style={styles.th}>Category</th>
                      <th style={styles.th}>Status</th>
                      <th style={styles.th}>S3 Storage Path</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredDocuments.length === 0 ? (
                      <tr>
                        <td colSpan={4} style={{ ...styles.td, textAlign: "center", color: "#666" }}>
                          No documents found.
                        </td>
                      </tr>
                    ) : (
                      filteredDocuments.map((doc) => (
                        <tr key={doc.documentId} style={{ borderBottomWidth: "1px", borderBottomStyle: "solid", borderBottomColor: "#eee" }}>
                          <td style={styles.td}>{doc.documentId}</td>
                          <td style={styles.td}>{doc.docType || "N/A"}</td>
                          <td style={styles.td}>
                            <span style={doc.status === "COMPLETED" ? styles.successBadge : styles.badge}>
                              {doc.status}
                            </span>
                          </td>
                          <td style={styles.td}>
                            <code style={{ fontSize: "0.8rem" }}>{doc.s3RawUri || "N/A"}</code>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </main>
        </div>
      )}
    </Authenticator>
  );
}

// 7. Styles Object (Non-conflicting properties)
const styles: { [key: string]: React.CSSProperties } = {
  container: {
    maxWidth: "1200px",
    margin: "0 auto",
    padding: "1.5rem",
    fontFamily: "system-ui, -apple-system, sans-serif",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    paddingBottom: "1rem",
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: "#e0e0e0",
  },
  userBadge: {
    backgroundColor: "#e3f2fd",
    color: "#0d47a1",
    padding: "0.4rem 0.8rem",
    borderRadius: "16px",
    fontSize: "0.85rem",
    fontWeight: 600,
  },
  navTabs: {
    display: "flex",
    gap: "0.5rem",
    marginTop: "1rem",
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: "#e0e0e0",
  },
  tabBtn: {
    padding: "0.75rem 1.25rem",
    borderTopStyle: "none",
    borderLeftStyle: "none",
    borderRightStyle: "none",
    borderBottomWidth: "2px",
    borderBottomStyle: "solid",
    borderBottomColor: "transparent",
    backgroundColor: "transparent",
    cursor: "pointer",
    fontWeight: 500,
    color: "#555",
  },
  activeTabBtn: {
    padding: "0.75rem 1.25rem",
    borderTopStyle: "none",
    borderLeftStyle: "none",
    borderRightStyle: "none",
    borderBottomWidth: "2px",
    borderBottomStyle: "solid",
    borderBottomColor: "#1976d2",
    backgroundColor: "transparent",
    cursor: "pointer",
    fontWeight: 700,
    color: "#1976d2",
  },
  content: {
    paddingTop: "1.5rem",
  },
  metricsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: "1rem",
  },
  card: {
    backgroundColor: "#ffffff",
    padding: "1.25rem",
    borderRadius: "8px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#e0e0e0",
    boxShadow: "0 2px 4px rgba(0,0,0,0.02)",
  },
  metricVal: {
    fontSize: "2rem",
    fontWeight: 700,
    margin: "0.5rem 0 0 0",
  },
  chartBarContainer: {
    display: "flex",
    height: "24px",
    backgroundColor: "#eee",
    borderRadius: "12px",
    overflow: "hidden",
    marginTop: "1rem",
  },
  chartBarSegment: {
    height: "100%",
    transition: "width 0.4s ease",
  },
  chartLegend: {
    display: "flex",
    gap: "1.5rem",
    marginTop: "0.75rem",
    fontSize: "0.9rem",
  },
  emptyState: {
    textAlign: "center",
    padding: "3rem",
    backgroundColor: "#f9f9f9",
    borderRadius: "8px",
    color: "#666",
    fontSize: "1.1rem",
  },
  uploadBox: {
    borderWidth: "2px",
    borderStyle: "dashed",
    borderColor: "#bbb",
    padding: "3rem",
    borderRadius: "8px",
    textAlign: "center",
    backgroundColor: "#fafafa",
  },
  input: {
    padding: "0.6rem 1rem",
    borderRadius: "6px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#ccc",
    fontSize: "0.9rem",
    flex: 1,
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    marginTop: "1rem",
  },
  th: {
    padding: "0.75rem",
    borderBottomWidth: "2px",
    borderBottomStyle: "solid",
    borderBottomColor: "#ccc",
    fontSize: "0.85rem",
    color: "#444",
  },
  td: {
    padding: "0.75rem",
    fontSize: "0.9rem",
  },
  badge: {
    backgroundColor: "#fff3e0",
    color: "#e65100",
    padding: "0.25rem 0.6rem",
    borderRadius: "4px",
    fontSize: "0.8rem",
    fontWeight: 600,
  },
  successBadge: {
    backgroundColor: "#e8f5e9",
    color: "#1b5e20",
    padding: "0.25rem 0.6rem",
    borderRadius: "4px",
    fontSize: "0.8rem",
    fontWeight: 600,
  },
  primaryBtn: {
    backgroundColor: "#1976d2",
    color: "#fff",
    border: "none",
    padding: "0.5rem 1rem",
    borderRadius: "4px",
    cursor: "pointer",
    fontWeight: 600,
  },
  secondaryBtn: {
    backgroundColor: "#f5f5f5",
    color: "#333",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#ccc",
    padding: "0.5rem 1rem",
    borderRadius: "4px",
    cursor: "pointer",
    fontWeight: 500,
  },
  successBtn: {
    backgroundColor: "#2e7d32",
    color: "#fff",
    border: "none",
    padding: "0.6rem 1.2rem",
    borderRadius: "4px",
    cursor: "pointer",
    fontWeight: 600,
    marginTop: "0.5rem",
  },
  extractionFormBox: {
    marginTop: "1rem",
    padding: "1.25rem",
    backgroundColor: "#f8f9fa",
    borderRadius: "8px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#e0e0e0",
  },
  formGroup: {
    display: "flex",
    flexDirection: "column",
    marginBottom: "1rem",
    flex: 1,
  },
  label: {
    fontSize: "0.85rem",
    fontWeight: 600,
    color: "#555",
    marginBottom: "0.4rem",
  },
  warningText: {
    color: "#d32f2f",
    fontWeight: 600,
    fontSize: "0.8rem",
  },
};