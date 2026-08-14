import { useEffect, useState, useMemo, useRef } from "react";
import type { Schema } from "../../amplify/data/resource";
import { generateClient } from "aws-amplify/data";
import { getUrl, list } from "aws-amplify/storage";
import ChatAssistant from './ChatAssistant'
import { fetchAuthSession } from 'aws-amplify/auth'

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

  // --- CHAT STATE ---
  const [accountantSub, setAccountantSub] = useState<string>("");

  // --- MOBILE RESPONSIVE STATE ---
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= 900);
  const [isMobileChatOpen, setIsMobileChatOpen] = useState(false);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth <= 900);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const [activeTab, setActiveTab] = useState<"triage" | "setup">("triage");
  const [accountantProfile, setAccountantProfile] = useState({
    name: "",
    firmName: "",
    address: "",
    contactEmail: ""
  });
  const [isSavingProfile, setIsSavingProfile] = useState(false);

  // Use a ref to prevent state updates on unmounted component
  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  // ─────────────────────────────────────────────────────────────────────────────
  // EVENT-DRIVEN STRATEGY: Initial GSI Load + Subscriptions (No Polling)
  // ─────────────────────────────────────────────────────────────────────────────
  
  const fetchProfiles = async (sub: string) => {
    try {
      const { data, errors } = await client.models.DocumentRecord.listByAccountantAndCompany(
        { accountantId: sub },
        { limit: 500 }
      );

      if (errors) {
        console.error("GSI Error (Profiles):", errors);
        return;
      }

      const mapping: Record<string, string> = {};
      (data ?? []).forEach((profile) => {
        if (profile.companyName) {
          mapping[profile.userId] = profile.companyName;
        }
      });
      if (isMounted.current) setCompanyMap(mapping);
    } catch (err: any) {
      console.error("Failed to fetch company profiles", err);
    }
  };

  useEffect(() => {
    setIsLoading(true);
    const subscriptions: any[] = [];
    
    const initializeDashboard = async () => {
      try {
        const session = await fetchAuthSession();
        const sub = session.tokens?.idToken?.payload.sub?.toString();
        if (!sub) return;

        if (isMounted.current) setAccountantSub(sub);

        // 1. Initial Secure GSI Fetch
        await fetchProfiles(sub);
        
        const { data, errors } = await client.models.DocumentRecord.listByAccountantAndStatus(
          { accountantId: sub },
          { limit: 1000 }
        );

        if (errors) throw new Error(errors[0].message);

        const accountantDocs = (data ?? []).filter((doc: any) =>
          doc.documentId && doc.documentId.startsWith("doc-")
        );
        
        if (isMounted.current) {
          setDocuments(accountantDocs);
          setIsLoading(false);
        }

        // 2. Client-Side Event Handlers
        const handleNewItem = (item: any) => {
          if (!isMounted.current) return;
          if (item.accountantId === sub && item.documentId?.startsWith("doc-")) {
            setDocuments(prev => prev.some(d => d.documentId === item.documentId) ? prev : [item, ...prev]);
          }
        };

        const handleUpdateItem = (item: any) => {
          if (!isMounted.current) return;
          if (item.accountantId === sub && item.documentId?.startsWith("doc-")) {
            setDocuments(prev => prev.map(d => d.documentId === item.documentId ? item : d));
          }
        };

        const handleDeleteItem = (item: any) => {
          if (!isMounted.current) return;
          if (item.accountantId === sub && item.documentId?.startsWith("doc-")) {
            setDocuments(prev => prev.filter(d => d.documentId !== item.documentId));
          }
        };

        // 3. Attach Live Subscriptions
        subscriptions.push(client.models.DocumentRecord.onCreate().subscribe({ next: handleNewItem }));
        subscriptions.push(client.models.DocumentRecord.onUpdate().subscribe({ next: handleUpdateItem }));
        subscriptions.push(client.models.DocumentRecord.onDelete().subscribe({ next: handleDeleteItem }));

      } catch (err) {
        console.error("Failed to initialize dashboard:", err);
        if (isMounted.current) setIsLoading(false);
      }
    };

    initializeDashboard();

    return () => {
      subscriptions.forEach(sub => sub.unsubscribe());
    };
  }, []);

  useEffect(() => {
    const loadAccountantProfile = async () => {
      if (!accountantSub) return;
      try {
        const { data } = await client.models.DocumentRecord.get({
          userId: accountantSub,
          documentId: "ACC"
        });
        if (data && isMounted.current) {
          setAccountantProfile({
            name: data.name || "",
            firmName: data.firmName || "",
            address: data.address || "",
            contactEmail: data.contactEmail || ""
          });
        }
      } catch (err) {
        console.error("Failed to load accountant profile:", err);
      }
    };
    loadAccountantProfile();
  }, [accountantSub]);

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
      if (isMounted.current) setIsGenerating(false);
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
      if (isMounted.current) setReportFiles(files);
    } catch (err) {
      console.error("Failed to list S3 compliance reports:", err);
      if (isMounted.current) setReportFiles([]);
    } finally {
      if (isMounted.current) setReportLoading(false);
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

  const handleSaveAccountantProfile = async () => {
    if (!accountantSub) {
      alert("Could not identify accountant. Please try again.");
      return;
    }
    if (!accountantProfile.name.trim() || !accountantProfile.firmName.trim()) {
      alert("Name and Firm Name are required.");
      return;
    }
    setIsSavingProfile(true);
    try {
      const existingProfile = await client.models.DocumentRecord.get({
        userId: accountantSub,
        documentId: "ACC"
      });

      const profilePayload = {
        userId: accountantSub,
        documentId: "ACC",
        accountantId: accountantSub,
        recordType: "PROFILE_ACC",
        name: accountantProfile.name,
        firmName: accountantProfile.firmName,
        address: accountantProfile.address,
        contactEmail: accountantProfile.contactEmail
      };

      let response;
      if (!existingProfile?.data) {
        response = await client.models.DocumentRecord.create(profilePayload);
      } else {
        response = await client.models.DocumentRecord.update(profilePayload);
      }

      if (response?.errors && Array.isArray(response.errors) && response.errors.length > 0) {
        alert(`⚠️ Profile Save Failed:\n\n${response.errors[0]?.message || "Unknown error"}`);
        return;
      }

      alert("Profile saved successfully!");
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      alert(`Failed to save profile: ${errorMessage}`);
    } finally {
      if (isMounted.current) setIsSavingProfile(false);
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
        accountantId: accountantSub,
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
        accountantId: accountantSub,
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
    <div className="dashboard-layout">
      {/* LEFT SIDE: Main Dashboard (65%) */}
      <main className="content dashboard-main">
        {/* NAV TABS */}
        <nav className="nav-tabs" style={{ display: "flex", gap: "1rem", borderBottom: "2px solid #e2e8f0", marginBottom: "1rem", paddingBottom: "0.5rem" }}>
          <button
            onClick={() => setActiveTab("triage")}
            className={activeTab === "triage" ? "active-tab-btn" : "tab-btn"}
            style={{
              padding: "0.75rem 1.5rem",
              border: "none",
              background: "none",
              fontSize: "1rem",
              fontWeight: activeTab === "triage" ? "700" : "500",
              color: activeTab === "triage" ? "#4f46e5" : "#64748b",
              cursor: "pointer",
              borderBottom: activeTab === "triage" ? "3px solid #4f46e5" : "none",
              marginBottom: "-0.5rem"
            }}
          >
            📋 Triage
          </button>
          <button
            onClick={() => setActiveTab("setup")}
            className={activeTab === "setup" ? "active-tab-btn" : "tab-btn"}
            style={{
              padding: "0.75rem 1.5rem",
              border: "none",
              background: "none",
              fontSize: "1rem",
              fontWeight: activeTab === "setup" ? "700" : "500",
              color: activeTab === "setup" ? "#4f46e5" : "#64748b",
              cursor: "pointer",
              borderBottom: activeTab === "setup" ? "3px solid #4f46e5" : "none",
              marginBottom: "-0.5rem"
            }}
          >
            ⚙️ Setup
          </button>
        </nav>

        {/* TRIAGE TAB */}
        {activeTab === "triage" && (
          <>
            {/* HEADER SECTION */}
            <div style={{ flexShrink: 0 }}>
              <h2 style={{ margin: "0 0 0.5rem 0" }}>Accountant Compliance Triage</h2>
              <p style={{ margin: "0 0 1rem 0", color: "#475569" }}>Click any row to review documents awaiting final COA validation and lock.</p>

              <div style={{ display: "flex", gap: "1rem", marginBottom: "1.5rem", flexWrap: "wrap" }}>
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

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem", gap: "1rem", flexWrap: "wrap" }}>
                <input
                  type="text"
                  placeholder="🔍 Search by Company Name..."
                  value={searchCompany}
                  onChange={(e) => setSearchCompany(e.target.value)}
                  className="input"
                  style={{ flex: "1 1 250px", padding: "0.6rem 1rem" }}
                />

                {searchCompany && uniqueCompanies.length === 1 && matchingUserId && (
                  <button
                    onClick={() => handleOpenReports(matchingUserId, uniqueCompanies[0])}
                    style={{ backgroundColor: "#4f46e5", color: "white", padding: "0.6rem 1.2rem", border: "none", borderRadius: "6px", cursor: "pointer", fontWeight: "bold", whiteSpace: "nowrap" }}
                  >
                    📊 View Reports ({uniqueCompanies[0]})
                  </button>
                )}
              </div>
            </div>

            {/* TABLE SECTION (Clickable Rows) */}
            <div className="table-scroll-wrapper">
              <table>
                <thead>
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
                      style={{ borderBottom: "1px solid #f1f5f9", cursor: "pointer", transition: "background-color 0.2s" }}
                      onMouseOver={(e) => e.currentTarget.style.backgroundColor = "#f1f5f9"}
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
                          color: doc.status === 'FINALIZED' ? '#166534' : '#7e22ce',
                          padding: "4px 12px",
                          borderRadius: "12px",
                          fontSize: "0.85rem",
                          fontWeight: "500"
                        }}>
                          {doc.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {sortedAndFilteredDocuments.length === 0 && !isLoading && (
                <div style={{ textAlign: "center", padding: "3rem", color: "#64748b" }}>
                  <p>No documents found. Check filters or wait for customer submissions.</p>
                </div>
              )}
              {isLoading && (
                <div style={{ textAlign: "center", padding: "3rem", color: "#64748b" }}>
                  <p>Loading documents...</p>
                </div>
              )}
            </div>
          </>
        )}

        {/* SETUP TAB */}
        {activeTab === "setup" && (
          <div style={{ maxWidth: "600px", margin: "0 auto", width: "100%" }}>
            <h2 style={{ margin: "0 0 1rem 0" }}>Your Profile</h2>
            <div style={{ backgroundColor: "white", padding: "2rem", borderRadius: "12px", border: "1px solid #e2e8f0", boxShadow: "0 1px 3px rgba(0,0,0,0.1)" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
                <div>
                  <label style={{ fontWeight: "600", color: "#1f2937", marginBottom: "0.5rem", display: "block" }}>Name</label>
                  <input
                    type="text"
                    value={accountantProfile.name}
                    onChange={(e) => setAccountantProfile({ ...accountantProfile, name: e.target.value })}
                    className="input"
                    placeholder="Your full name"
                    style={{ width: "100%", padding: "0.75rem 1rem" }}
                  />
                </div>

                <div>
                  <label style={{ fontWeight: "600", color: "#1f2937", marginBottom: "0.5rem", display: "block" }}>Firm Name</label>
                  <input
                    type="text"
                    value={accountantProfile.firmName}
                    onChange={(e) => setAccountantProfile({ ...accountantProfile, firmName: e.target.value })}
                    className="input"
                    placeholder="Your accounting firm name"
                    style={{ width: "100%", padding: "0.75rem 1rem" }}
                  />
                </div>

                <div>
                  <label style={{ fontWeight: "600", color: "#1f2937", marginBottom: "0.5rem", display: "block" }}>Address</label>
                  <input
                    type="text"
                    value={accountantProfile.address}
                    onChange={(e) => setAccountantProfile({ ...accountantProfile, address: e.target.value })}
                    className="input"
                    placeholder="Business address"
                    style={{ width: "100%", padding: "0.75rem 1rem" }}
                  />
                </div>

                <div>
                  <label style={{ fontWeight: "600", color: "#1f2937", marginBottom: "0.5rem", display: "block" }}>Contact Email</label>
                  <input
                    type="email"
                    value={accountantProfile.contactEmail}
                    onChange={(e) => setAccountantProfile({ ...accountantProfile, contactEmail: e.target.value })}
                    className="input"
                    placeholder="your.email@firm.com"
                    style={{ width: "100%", padding: "0.75rem 1rem" }}
                  />
                </div>

                <button
                  onClick={handleSaveAccountantProfile}
                  disabled={isSavingProfile}
                  style={{
                    backgroundColor: "#4f46e5",
                    color: "white",
                    padding: "0.75rem 1.5rem",
                    borderRadius: "6px",
                    border: "none",
                    cursor: isSavingProfile ? "not-allowed" : "pointer",
                    fontWeight: "600",
                    marginTop: "1rem"
                  }}
                >
                  {isSavingProfile ? "Saving..." : "Save Profile"}
                </button>
              </div>
            </div>
          </div>
        )}

        {selectedDocument && (
          <div style={{
            position: "fixed", top: 0, left: 0, width: "100vw", height: "100vh",
            backgroundColor: "rgba(0,0,0,0.5)", display: "flex", justifyContent: "center", alignItems: "center", zIndex: 1000
          }}>
            <div style={{
              background: "white", padding: "2rem", borderRadius: "12px", width: "90%", maxWidth: "700px",
              boxShadow: "0 20px 25px -5px rgba(0,0,0,0.1)", maxHeight: "90vh", overflowY: "auto"
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

              <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", marginTop: "1rem", gap: "12px" }}>
                {isRejecting ? (
                  <div style={{ display: "flex", gap: "8px", alignItems: "center", width: "100%" }}>
                    <input
                      type="text"
                      placeholder="Reason for return..."
                      value={rejectionNote}
                      onChange={(e) => setRejectionNote(e.target.value)}
                      className="input"
                      style={{ flex: 1 }}
                    />
                    <button
                      onClick={() => handleReturnToCustomer(selectedDocument)}
                      style={{ backgroundColor: "#ef4444", color: "white", padding: "10px 15px", border: "none", borderRadius: "6px", cursor: "pointer", fontWeight: "bold", whiteSpace: "nowrap" }}
                    >
                      Send Back
                    </button>
                    <button onClick={() => setIsRejecting(false)} className="secondary-btn" style={{ border: "none", background: "transparent", whiteSpace: "nowrap" }}>Cancel</button>
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

      {/* RIGHT SIDE: Chat Assistant — desktop sidebar (hidden on mobile via CSS) */}
      <aside className="dashboard-sidebar">
        <ChatAssistant
          viewerRole="ACCOUNTANT"
          accountantId={accountantSub}
          customerId={selectedDocument ? selectedDocument.userId : 'GLOBAL'}
          documentId={selectedDocument ? selectedDocument.documentId : 'dashboard_general'}
        />
      </aside>

      {/* Mobile FAB */}
      {isMobile && !isMobileChatOpen && (
        <button
          className="chat-fab"
          onClick={() => setIsMobileChatOpen(true)}
          aria-label="Open AI Assistant"
        >
          🤖
        </button>
      )}

      {/* Mobile full-screen chat modal */}
      {isMobile && isMobileChatOpen && (
        <div className="mobile-chat-modal" role="dialog" aria-modal="true" aria-label="AI Assistant">
          <div className="mobile-chat-modal-header">
            <p className="mobile-chat-modal-title">🤖 Document Assistant</p>
            <button
              className="mobile-chat-modal-close"
              onClick={() => setIsMobileChatOpen(false)}
              aria-label="Close chat"
            >
              ✕ Close
            </button>
          </div>
          <div className="mobile-chat-modal-body">
            <ChatAssistant
              viewerRole="ACCOUNTANT"
              accountantId={accountantSub}
              customerId={selectedDocument ? selectedDocument.userId : 'GLOBAL'}
              documentId={selectedDocument ? selectedDocument.documentId : 'dashboard_general'}
            />
          </div>
        </div>
      )}
    </div>
  );
}