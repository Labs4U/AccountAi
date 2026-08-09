import { useEffect, useState } from "react";
import type { Schema } from "../../amplify/data/resource";
import { generateClient } from "aws-amplify/data";
import { getUrl } from "aws-amplify/storage";

const client = generateClient<Schema>();

export default function AccountantDashboard() {
  const [documents, setDocuments] = useState<Array<Schema["DocumentRecord"]["type"]>>([]);
  const [companyMap, setCompanyMap] = useState<Record<string, string>>({});
  
  // Pagination & Search State
  const [nextToken, setNextToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [searchCompany, setSearchCompany] = useState("");
  
  // Modal State
  const [selectedDocument, setSelectedDocument] = useState<Schema["DocumentRecord"]["type"] | null>(null);
  const [rejectionNote, setRejectionNote] = useState("");
  const [isRejecting, setIsRejecting] = useState(false);

  const handleReturnToCustomer = async (doc: Schema["DocumentRecord"]["type"]) => {
    if (!rejectionNote.trim()) {
      alert("Please enter a reason for returning the document.");
      return;
    }
    try {
      await client.models.DocumentRecord.update({
        userId: doc.userId,
        documentId: doc.documentId,
        status: "PENDING_CUSTOMER", // Pushes it back to the customer's Action Required queue
        accountantNote: rejectionNote
      });
      
      setDocuments(prev => prev.filter(d => d.documentId !== doc.documentId));
      setSelectedDocument(null);
      setRejectionNote("");
      setIsRejecting(false);
    } catch (err) {
      alert("Failed to return document.");
    }
  };

  const fetchProfiles = async () => {
    try {
      const { data } = await client.models.DocumentRecord.list({
        filter: { documentId: { eq: "CONFIG" } }
      });
      const mapping: Record<string, string> = {};
      data.forEach(profile => {
        mapping[profile.userId] = profile.companyName || "Unknown Company";
      });
      setCompanyMap(mapping);
    } catch (err) {
      console.error("Failed to fetch company profiles", err);
    }
  };

useEffect(() => {
    // 1. Fetch company names first so the table knows who is who
    fetchProfiles();

    // 2. Open a real-time WebSocket connection for all documents
    setIsLoading(true);
    const subscription = client.models.DocumentRecord.observeQuery().subscribe({
      next: (data) => {
        // Filter out the CONFIG/PROFILE records
        const accountantDocs = data.items.filter(doc => doc.recordType !== "PROFILE");

        // Sort by newest first and instantly push to the UI table
        const sortedDocs = [...accountantDocs].sort((a, b) => 
          (b.createdAt || "").localeCompare(a.createdAt || "")
        );

        setDocuments(sortedDocs);
        setIsLoading(false);
      },
      error: (err) => {
        console.error("Accountant subscription error:", err);
        setIsLoading(false);
      }
    });

    // 3. Clean up the WebSocket when closing the page
    return () => subscription.unsubscribe();
  }, []);

  const handleApproveAndFinalize = async (doc: Schema["DocumentRecord"]["type"]) => {
    try {
      await client.models.DocumentRecord.update({
        userId: doc.userId,
        documentId: doc.documentId,
        status: "FINALIZED"
      });
      setDocuments(prev => prev.map(d => d.documentId === doc.documentId ? { ...d, status: "FINALIZED" } : d));
      setSelectedDocument(null);
      alert("Document Finalized and locked to Ledger!");
    } catch (err) {
      alert("Failed to finalize document.");
    }
  };

  const handleViewDocument = async (doc: Schema["DocumentRecord"]["type"]) => {
    // 1. Prefer the final URI, fallback to raw if it's an old document
    const uri = doc.s3FinalUri || doc.s3RawUri;
    
    if (!uri) return alert("Document URL not found.");
    
    try {
      let path = uri.replace("s3://account-ai-bh/", "");
      
      // 2. LEGACY HACK: If the database only has the /raw/ path, but the document 
      // is already processed, we know the AI Agent moved it to /invoice/!
      if (path.includes("/raw/") && doc.status !== "PROCESSING") {
        path = path.replace("/raw/", "/invoice/");
      }

      const linkToStorageFile = await getUrl({ path });
      window.open(linkToStorageFile.url.toString(), "_blank");
    } catch (err) {
      alert("Failed to fetch document link.");
    }
  };

  const filteredDocuments = documents.filter(doc => {
    const compName = companyMap[doc.userId] || "Unknown Company";
    const matchesSearch = compName.toLowerCase().includes(searchCompany.toLowerCase());
    const isSubmitted = doc.status !== "PROCESSING" && doc.status !== "PENDING_CUSTOMER";
    return matchesSearch && isSubmitted;
  });

  const uniqueCompanies = Array.from(new Set(filteredDocuments.map(doc => companyMap[doc.userId] || "Unknown Company")));

  return (
    <main className="content" style={{ padding: "1.5rem 2rem", display: "flex", flexDirection: "column", height: "calc(100vh - 80px)", boxSizing: "border-box" }}>
      {/* HEADER SECTION (Fixed) */}
      <div style={{ flexShrink: 0 }}>
        <h2 style={{ margin: "0 0 0.5rem 0" }}>Accountant Compliance Triage</h2>
        <p style={{ margin: "0 0 1rem 0", color: "#475569" }}>Documents approved by customers awaiting final COA validation and lock.</p>

        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "1rem" }}>
          <input 
            type="text" 
            placeholder="🔍 Search by Company Name..." 
            value={searchCompany}
            onChange={(e) => setSearchCompany(e.target.value)}
            className="input"
            style={{ maxWidth: "350px", padding: "0.6rem 1rem" }}
          />
          <button onClick={() => fetchDocuments()} className="secondary-btn" disabled={isLoading}>
            🔄 Refresh
          </button>
        </div>

        {searchCompany && uniqueCompanies.length === 1 && (
          <div style={{ padding: "0.75rem 1rem", backgroundColor: "#e0e7ff", borderRadius: "6px", marginBottom: "1rem", fontWeight: "bold", color: "#3730a3", display: "inline-block" }}>
            📁 Viewing Submitted Records for: {uniqueCompanies[0]}
          </div>
        )}
        {searchCompany && uniqueCompanies.length === 0 && (
          <div style={{ color: "#ef4444", marginBottom: "1rem", fontStyle: "italic" }}>
            No submitted documents found for this search.
          </div>
        )}
      </div>

      {/* TABLE SECTION (Scrollable) */}
      <div style={{ flex: 1, overflowY: "auto", borderRadius: "8px", border: "1px solid #e2e8f0", backgroundColor: "white", position: "relative" }}>
        <table style={{ width: "100%", textAlign: "left", borderCollapse: "collapse" }}>
          <thead style={{ position: "sticky", top: 0, backgroundColor: "#f8fafc", zIndex: 10, boxShadow: "0 1px 2px rgba(0,0,0,0.05)" }}>
            <tr>
              <th style={{ padding: "12px", borderBottom: "2px solid #e2e8f0" }}>Company</th>
              <th style={{ padding: "12px", borderBottom: "2px solid #e2e8f0" }}>Vendor</th>
              <th style={{ padding: "12px", borderBottom: "2px solid #e2e8f0" }}>Date</th>
              <th style={{ padding: "12px", borderBottom: "2px solid #e2e8f0" }}>Total</th>
              <th style={{ padding: "12px", borderBottom: "2px solid #e2e8f0" }}>Status</th>
              <th style={{ padding: "12px", borderBottom: "2px solid #e2e8f0" }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {filteredDocuments.map((doc) => (
              <tr key={doc.documentId} style={{ borderBottom: "1px solid #f1f5f9" }} onMouseOver={(e) => e.currentTarget.style.backgroundColor = "#f8fafc"} onMouseOut={(e) => e.currentTarget.style.backgroundColor = "transparent"}>
                <td style={{ padding: "12px", fontWeight: "bold", color: "#334155" }}>
                  {companyMap[doc.userId] || "Unknown"}
                </td>
                <td style={{ padding: "12px" }}>{doc.extractedVendor}</td>
                <td style={{ padding: "12px" }}>{doc.extractedDate}</td>
                <td style={{ padding: "12px" }}>${doc.extractedTotal}</td>
                <td style={{ padding: "12px" }}>
                  <span className="badge" style={{ 
                    backgroundColor: doc.status === 'FINALIZED' ? '#dcfce7' : '#f3e8ff',
                    color: doc.status === 'FINALIZED' ? '#166534' : '#7e22ce'
                  }}>
                    {doc.status}
                  </span>
                </td>
                <td style={{ padding: "12px" }}>
                  <button 
                    onClick={() => {
                      setSelectedDocument(doc);
                      setIsRejecting(false); // Reset rejection state when opening a new modal
                    }}
                    className="primary-btn"
                    style={{ padding: "6px 12px", fontSize: "0.85rem" }}
                  >
                    Review
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* PAGINATION CONTROLS */}
      {nextToken && !searchCompany && (
        <div style={{ flexShrink: 0, display: "flex", justifyContent: "center", marginTop: "1rem" }}>
          <button onClick={() => fetchDocuments(nextToken)} className="secondary-btn" disabled={isLoading}>
            {isLoading ? "Loading..." : "Load Next Page ▼"}
          </button>
        </div>
      )}

      {/* REVIEW MODAL */}
      {selectedDocument && (
        <div style={{
          position: "fixed", top: 0, left: 0, width: "100vw", height: "100vh",
          backgroundColor: "rgba(0,0,0,0.5)", display: "flex", justifyContent: "center", alignItems: "center", zIndex: 1000
        }}>
          <div style={{
            background: "white", padding: "2rem", borderRadius: "12px", width: "90%", maxWidth: "700px",
            boxShadow: "0 20px 25px -5px rgba(0,0,0,0.1)"
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "1.5rem" }}>
              <div>
                <p style={{ margin: 0, fontSize: "0.9rem", color: "#64748b" }}><strong>Customer SUB:</strong> {selectedDocument.userId}</p>
                <h3 style={{ margin: "4px 0 0 0" }}>Doc ID: {selectedDocument.documentId}</h3>
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "8px" }}>
                <span className="badge" style={{ backgroundColor: "#9333ea", color: "white", fontSize: "0.8rem", padding: "6px 12px" }}>
                  {selectedDocument.status}
                </span>
                <button 
  onClick={() => handleViewDocument(selectedDocument)} // <-- PASS THE OBJECT HERE
  style={{ fontSize: "0.75rem", padding: "4px 8px", backgroundColor: "#f1f5f9", border: "1px solid #cbd5e1", borderRadius: "4px", cursor: "pointer" }}
>
  👁️ View Original
</button>
              </div>
            </div>

            <div style={{ backgroundColor: "#f8fafc", padding: "1.5rem", borderRadius: "8px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.5rem", marginBottom: "2rem" }}>
              <div><strong>Vendor:</strong> {selectedDocument.extractedVendor || "-"}</div>
              <div><strong>Total:</strong> ${selectedDocument.extractedTotal || "-"}</div>
              <div><strong>Date:</strong> {selectedDocument.extractedDate || "-"}</div>
              <div><strong>Tax (VAT):</strong> ${selectedDocument.extractedTax || "-"}</div>
              <div><strong>TRN:</strong> {selectedDocument.vendorTRN || "NOT_FOUND"}</div>
              <div><strong>Proposed COA:</strong> {selectedDocument.mappedAccountCode ? `${selectedDocument.mappedAccountCode} - ${selectedDocument.mappedAccountName}` : "-"}</div>
            </div>

            {/* --- REPLACED MODAL BUTTON ROW --- */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "1rem" }}>
              
              <button 
                onClick={() => alert("Bedrock MCP Agent connection will open here.")} 
                style={{ backgroundColor: "#2563eb", color: "white", padding: "10px 20px", border: "none", borderRadius: "6px", cursor: "pointer", fontWeight: "bold" }}
              >
                Ask AI Agent (MCP)
              </button>

              <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
                {isRejecting ? (
                  <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                    <input 
                      type="text" 
                      placeholder="Reason for return..." 
                      value={rejectionNote}
                      onChange={(e) => setRejectionNote(e.target.value)}
                      className="input"
                      style={{ width: "200px" }}
                    />
                    <button 
                      onClick={() => handleReturnToCustomer(selectedDocument)}
                      style={{ backgroundColor: "#ef4444", color: "white", padding: "10px 15px", border: "none", borderRadius: "6px", cursor: "pointer", fontWeight: "bold" }}
                    >
                      Send Back
                    </button>
                    <button onClick={() => setIsRejecting(false)} className="secondary-btn" style={{ border: "none", background: "transparent" }}>Cancel</button>
                  </div>
                ) : (
                  <>
                    <button 
                      onClick={() => setIsRejecting(true)} 
                      style={{ backgroundColor: "#f59e0b", color: "white", padding: "10px 20px", border: "none", borderRadius: "6px", cursor: "pointer", fontWeight: "bold" }}
                    >
                      Request Info
                    </button>
                    {selectedDocument.status !== "FINALIZED" && (
                      <button 
                        onClick={() => handleApproveAndFinalize(selectedDocument)} 
                        style={{ backgroundColor: "#16a34a", color: "white", padding: "10px 20px", border: "none", borderRadius: "6px", cursor: "pointer", fontWeight: "bold" }}
                      >
                        Approve & Finalize
                      </button>
                    )}
                    <button onClick={() => setSelectedDocument(null)} className="secondary-btn" style={{ border: "none", background: "transparent", color: "#64748b" }}>
                      Close
                    </button>
                  </>
                )}
              </div>
            </div>
            {/* --- END OF REPLACED MODAL BUTTON ROW --- */}

          </div>
        </div>
      )}
    </main>
  );
}