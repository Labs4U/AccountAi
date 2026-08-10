import { useEffect, useState, useMemo } from "react";
import type { Schema } from "../../amplify/data/resource";
import { generateClient } from "aws-amplify/data";
import { getUrl, list } from "aws-amplify/storage";

const client = generateClient<Schema>();

export default function AccountantDashboard() {
  const [documents, setDocuments] = useState<Array<Schema["DocumentRecord"]["type"]>>([]);
  const [companyMap, setCompanyMap] = useState<Record<string, string>>({});
  
  // Search & Loading State
  const [isLoading, setIsLoading] = useState(false);
  const [searchCompany, setSearchCompany] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  
  // Sorting State
  const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'ascending' | 'descending' } | null>(null);

  // Modal State
  const [selectedDocument, setSelectedDocument] = useState<Schema["DocumentRecord"]["type"] | null>(null);
  const [rejectionNote, setRejectionNote] = useState("");
  const [isRejecting, setIsRejecting] = useState(false);

  // 📂 Compliance Reports Archive Modal State
  const [showReportsModal, setShowReportsModal] = useState(false);
  const [reportFiles, setReportFiles] = useState<any[]>([]);
  const [reportLoading, setReportLoading] = useState(false);
  const [activeCompanyReports, setActiveCompanyReports] = useState<{ userId: string; name: string } | null>(null);

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
    fetchProfiles();
    setIsLoading(true);
    
    const subscription = client.models.DocumentRecord.observeQuery().subscribe({
      next: (data) => {
        const accountantDocs = data.items.filter(doc => doc.recordType !== "PROFILE");
        setDocuments(accountantDocs);
        setIsLoading(false);
      },
      error: (err) => {
        console.error("Accountant subscription error:", err);
        setIsLoading(false);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  // 🧪 MANUAL LAMBDA TRIGGER
  const handleTriggerReports = async () => {
    setIsGenerating(true);
    try {
      const result = await client.mutations.triggerReportsManual();
      console.log("Lambda Result:", result);
      alert(`Success! Reports generated manually.\nResponse: ${JSON.stringify(result.data)}`);
    } catch (err) {
      console.error("Failed to trigger lambda", err);
      alert("Failed to generate reports. Check console.");
    } finally {
      setIsGenerating(false);
    }
  };

  // 📂 S3 REPORT FETCHING
  const handleOpenReports = async (userId: string | null, companyName: string) => {
    setActiveCompanyReports({ userId: userId || 'GLOBAL', name: companyName });
    setShowReportsModal(true);
    setReportLoading(true);

    const prefix = userId 
      ? `reports/${userId}_${companyName.replace(/[^a-zA-Z0-9_-]/g, "_")}/` 
      : `reports/`;

    try {
      const result = await list({ path: prefix });
      const files = result.items.filter(item => item.size && item.size > 0);
      setReportFiles(files);
    } catch (err) {
      console.error("Failed to list S3 compliance reports:", err);
      setReportFiles([]);
    } finally {
      setReportLoading(false);
    }
  };

  const handleDownloadReportFile = async (path: string) => {
    try {
      const link = await getUrl({ path });
      window.open(link.url.toString(), "_blank");
    } catch (err) {
      alert("Failed to generate download link for report.");
    }
  };

  const handleReturnToCustomer = async (doc: Schema["DocumentRecord"]["type"]) => {
    if (!rejectionNote.trim()) {
      alert("Please enter a reason for returning the document.");
      return;
    }
    try {
      await client.models.DocumentRecord.update({
        userId: doc.userId,
        documentId: doc.documentId,
        status: "PENDING_CUSTOMER",
        accountantNote: rejectionNote
      });
      setSelectedDocument(null);
      setRejectionNote("");
      setIsRejecting(false);
    } catch (err) {
      alert("Failed to return document.");
    }
  };

  const handleApproveAndFinalize = async (doc: Schema["DocumentRecord"]["type"]) => {
    try {
      await client.models.DocumentRecord.update({
        userId: doc.userId,
        documentId: doc.documentId,
        status: "FINALIZED"
      });
      setSelectedDocument(null);
      alert("Document Finalized and locked to Ledger!");
    } catch (err) {
      alert("Failed to finalize document.");
    }
  };

  const handleViewDocument = async (doc: Schema["DocumentRecord"]["type"]) => {
    const uri = doc.s3FinalUri || doc.s3RawUri;
    if (!uri) return alert("Document URL not found.");
    try {
      let path = uri.replace("s3://account-ai-bh/", "");
      if (path.includes("/raw/") && doc.status !== "PROCESSING") {
        path = path.replace("/raw/", "/invoice/");
      }
      const linkToStorageFile = await getUrl({ path });
      window.open(linkToStorageFile.url.toString(), "_blank");
    } catch (err) {
      alert("Failed to fetch document link.");
    }
  };

  // 🔄 SORTING LOGIC
  const handleSort = (key: string) => {
    let direction: 'ascending' | 'descending' = 'ascending';
    if (sortConfig && sortConfig.key === key && sortConfig.direction === 'ascending') {
      direction = 'descending';
    }
    setSortConfig({ key, direction });
  };

  const sortedAndFilteredDocuments = useMemo(() => {
    let filtered = documents.filter(doc => {
      const compName = companyMap[doc.userId] || "Unknown Company";
      const matchesSearch = compName.toLowerCase().includes(searchCompany.toLowerCase());
      const isSubmitted = doc.status !== "PROCESSING" && doc.status !== "PENDING_CUSTOMER";
      return matchesSearch && isSubmitted;
    });

    if (sortConfig !== null) {
      filtered.sort((a, b) => {
        let aValue: any = a[sortConfig.key as keyof typeof a];
        let bValue: any = b[sortConfig.key as keyof typeof b];

        if (sortConfig.key === 'Company') {
          aValue = companyMap[a.userId] || "";
          bValue = companyMap[b.userId] || "";
        }

        if (aValue < bValue) return sortConfig.direction === 'ascending' ? -1 : 1;
        if (aValue > bValue) return sortConfig.direction === 'ascending' ? 1 : -1;
        return 0;
      });
    } else {
      filtered.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    }
    return filtered;
  }, [documents, companyMap, searchCompany, sortConfig]);

  const uniqueCompanies = Array.from(new Set(sortedAndFilteredDocuments.map(doc => companyMap[doc.userId] || "Unknown Company")));
  const matchingUserId = Object.keys(companyMap).find(id => companyMap[id] === uniqueCompanies[0]);

  const SortableHeader = ({ label, sortKey }: { label: string, sortKey: string }) => (
    <th 
      onClick={() => handleSort(sortKey)} 
      style={{ padding: "12px", borderBottom: "2px solid #e2e8f0", cursor: "pointer", userSelect: "none" }}
    >
      {label} {sortConfig?.key === sortKey ? (sortConfig.direction === 'ascending' ? '↑' : '↓') : '↕'}
    </th>
  );

  return (
    <main className="content" style={{ padding: "1.5rem 2rem", display: "flex", flexDirection: "column", height: "calc(100vh - 80px)", boxSizing: "border-box" }}>
      {/* HEADER SECTION */}
      <div style={{ flexShrink: 0 }}>
        <h2 style={{ margin: "0 0 0.5rem 0" }}>Accountant Compliance Triage</h2>
        <p style={{ margin: "0 0 1rem 0", color: "#475569" }}>Click any row to review documents awaiting final COA validation and lock.</p>

        <div style={{ display: "flex", gap: "1rem", marginBottom: "1.5rem" }}>
          <button 
            onClick={handleTriggerReports}
            disabled={isGenerating}
            style={{ backgroundColor: "#0f172a", color: "white", padding: "0.5rem 1rem", borderRadius: "6px", cursor: isGenerating ? "not-allowed" : "pointer" }}
          >
            {isGenerating ? "⏳ Generating..." : "🧪 TEST: Trigger Report Generation"}
          </button>
          
          <button 
            onClick={() => handleOpenReports(null, "All Global Reports")}
            style={{ backgroundColor: "#475569", color: "white", padding: "0.5rem 1rem", borderRadius: "6px", cursor: "pointer" }}
          >
            🌍 View ALL Generated Reports
          </button>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <input 
            type="text" 
            placeholder="🔍 Search by Company Name..." 
            value={searchCompany}
            onChange={(e) => setSearchCompany(e.target.value)}
            className="input"
            style={{ maxWidth: "350px", padding: "0.6rem 1rem" }}
          />

          {searchCompany && uniqueCompanies.length === 1 && matchingUserId && (
            <button 
              onClick={() => handleOpenReports(matchingUserId, uniqueCompanies[0])}
              style={{ backgroundColor: "#4f46e5", color: "white", padding: "0.6rem 1.2rem", border: "none", borderRadius: "6px", cursor: "pointer", fontWeight: "bold" }}
            >
              📊 View Compliance Reports ({uniqueCompanies[0]})
            </button>
          )}
        </div>
      </div>

      {/* TABLE SECTION (Clickable Rows) */}
      <div style={{ flex: 1, overflowY: "auto", borderRadius: "8px", border: "1px solid #e2e8f0", backgroundColor: "white", position: "relative" }}>
        <table style={{ width: "100%", textAlign: "left", borderCollapse: "collapse" }}>
          <thead style={{ position: "sticky", top: 0, backgroundColor: "#f8fafc", zIndex: 10, boxShadow: "0 1px 2px rgba(0,0,0,0.05)" }}>
            <tr>
              <SortableHeader label="Company" sortKey="Company" />
              <SortableHeader label="Vendor" sortKey="extractedVendor" />
              <SortableHeader label="Date" sortKey="extractedDate" />
              <SortableHeader label="Total" sortKey="extractedTotal" />
              <SortableHeader label="Status" sortKey="status" />
            </tr>
          </thead>
          <tbody>
            {sortedAndFilteredDocuments.map((doc) => (
              <tr 
                key={doc.documentId} 
                onClick={() => { setSelectedDocument(doc); setIsRejecting(false); }}
                style={{ borderBottom: "1px solid #f1f5f9", cursor: "pointer" }} 
                onMouseOver={(e) => e.currentTarget.style.backgroundColor = "#f8fafc"} 
                onMouseOut={(e) => e.currentTarget.style.backgroundColor = "transparent"}
              >
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
              </tr>
            ))}
          </tbody>
        </table>
      </div>

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
                  onClick={() => handleViewDocument(selectedDocument)} 
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
          </div>
        </div>
      )}

      {/* 📂 COMPLIANCE REPORTS ARCHIVE MODAL */}
      {showReportsModal && activeCompanyReports && (
        <div style={{
          position: "fixed", top: 0, left: 0, width: "100vw", height: "100vh",
          backgroundColor: "rgba(0,0,0,0.6)", display: "flex", justifyContent: "center", alignItems: "center", zIndex: 1000
        }}>
          <div style={{
            background: "white", padding: "2rem", borderRadius: "12px", width: "90%", maxWidth: "750px",
            maxHeight: "85vh", overflowY: "auto", boxShadow: "0 20px 25px -5px rgba(0,0,0,0.2)"
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
              <div>
                <h3 style={{ margin: 0, color: "#1e293b" }}>Compliance Reports Archive</h3>
                <p style={{ margin: "4px 0 0 0", color: "#64748b", fontSize: "0.9rem" }}>Viewing: <strong>{activeCompanyReports.name}</strong></p>
              </div>
              <button onClick={() => setShowReportsModal(false)} style={{ background: "none", border: "none", fontSize: "1.5rem", cursor: "pointer", color: "#64748b" }}>✖</button>
            </div>

            {reportLoading ? (
              <p style={{ textAlign: "center", padding: "2rem", color: "#64748b" }}>Loading generated reports from S3...</p>
            ) : reportFiles.length === 0 ? (
              <div style={{ textAlign: "center", padding: "2.5rem", backgroundColor: "#f8fafc", borderRadius: "8px", color: "#64748b" }}>
                <p style={{ margin: 0, fontWeight: "600" }}>No compliance reports found.</p>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                {reportFiles.map((file, idx) => (
                  <div key={idx} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "1rem", backgroundColor: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "8px" }}>
                    <div>
                      <p style={{ margin: 0, fontWeight: "bold", color: "#334155", fontSize: "0.95rem" }}>
                        {file.path.split('/').pop()}
                      </p>
                      <p style={{ margin: "2px 0 0 0", fontSize: "0.75rem", color: "#64748b" }}>
                        Path: {file.path}
                      </p>
                    </div>
                    <button 
                      onClick={() => handleDownloadReportFile(file.path)}
                      style={{ backgroundColor: "#2563eb", color: "white", padding: "8px 14px", border: "none", borderRadius: "6px", cursor: "pointer", fontWeight: "bold", fontSize: "0.85rem" }}
                    >
                      📥 Download CSV
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "2rem" }}>
              <button onClick={() => setShowReportsModal(false)} className="secondary-btn">Close Archive</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}