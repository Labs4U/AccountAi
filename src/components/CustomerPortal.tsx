import { useEffect, useState, useRef} from "react";
import type { Schema } from "../../amplify/data/resource";
import { generateClient } from "aws-amplify/data";
import { fetchAuthSession } from "aws-amplify/auth";
import { uploadData, getUrl } from "aws-amplify/storage";

const client = generateClient<Schema>();

export default function CustomerPortal() {
  const [activeTab, setActiveTab] = useState<"upload" | "library" | "setup">("library");
  const [documents, setDocuments] = useState<Array<Schema["DocumentRecord"]["type"]>>([]);
  const [isUploading, setIsUploading] = useState(false);
  
  // --- CONFIG / SETUP STATE ---
  const [userSub, setUserSub] = useState<string>("");
  const [uploadProgress, setUploadProgress] = useState(0);
  const isMounted = useRef(true);
  const [configRecordId, setConfigRecordId] = useState<string | null>(null);
  const [companyName, setCompanyName] = useState("");
  const [companyType, setCompanyType] = useState("WLL");
  const [companyAddress, setCompanyAddress] = useState("");
  const [companyTrn, setCompanyTrn] = useState("");
  
  // --- COA STATE & MODALS ---
  const [coaList, setCoaList] = useState<{ code: string; name: string }[]>([]);
  const [isCoaModalOpen, setIsCoaModalOpen] = useState(false);
  const [selectedDocument, setSelectedDocument] = useState<Schema["DocumentRecord"]["type"] | null>(null);

  // --- NEW: CUSTOM DROPDOWN STATE ---
  const [coaSearch, setCoaSearch] = useState("");
  const [showCoaDropdown, setShowCoaDropdown] = useState(false);
  

  useEffect(() => {
    fetchAuthSession().then(session => {
      const sub = session.tokens?.idToken?.payload.sub?.toString();
      if (sub) {
        setUserSub(sub);
        
        const subscription = client.models.DocumentRecord.observeQuery({
          filter: { userId: { eq: sub } }
        }).subscribe({
          next: (data) => {
            const config = data.items.find(d => d.documentId === "CONFIG");
            const docs = data.items.filter(d => d.documentId !== "CONFIG");

            setDocuments([...docs].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")));

            if (config) {
              setConfigRecordId(config.documentId); 
              setCompanyName(config.companyName || "");
              setCompanyType(config.companyType || "WLL");
              setCompanyAddress(config.companyAddress || "");
              setCompanyTrn(config.companyTrn || "");
              
              try {
                if (typeof config.chartOfAccounts === "string") {
                  setCoaList(JSON.parse(config.chartOfAccounts));
                } else if (Array.isArray(config.chartOfAccounts)) {
                  setCoaList(config.chartOfAccounts);
                }
              } catch (err) {
                console.error("Failed to parse COA array from DynamoDB", err);
              }
            }
          }
        });
        return () => subscription.unsubscribe();
      }
    });
  }, []);

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userSub) return;

    try {
      let response;
      // 1. MUST stringify the array for the AWSJSON schema type
      const formattedCoa = JSON.stringify(coaList); 

      if (configRecordId) {
        response = await client.models.DocumentRecord.update({
          userId: userSub,
          documentId: "CONFIG",
          companyName,
          companyType,
          companyAddress,
          companyTrn,
          chartOfAccounts: formattedCoa // 2. Pass the stringified version
        });
      } else {
        response = await client.models.DocumentRecord.create({
          userId: userSub,
          documentId: "CONFIG",
          recordType: "PROFILE",
          companyName,
          companyType,
          companyAddress,
          companyTrn,
          chartOfAccounts: formattedCoa // 3. Pass the stringified version
        });
      }

      if (response.errors) {
        alert(`Save failed: ${response.errors[0].message}`);
        return;
      }
      alert("Company Setup Saved!");
    } catch (err: any) {
      alert(`Failed to save profile: ${err.message || err}`);
    }
  };

  const addCoa = () => setCoaList([...coaList, { code: "", name: "" }]);
  const updateCoa = (index: number, field: "code" | "name", value: string) => {
    const updated = [...coaList];
    updated[index][field] = value;
    setCoaList(updated);
  };
  const removeCoa = (index: number) => setCoaList(coaList.filter((_, i) => i !== index));

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !userSub) return;
    
    setIsUploading(true);
    setUploadProgress(0); 

    try {
      const documentId = `doc-${Date.now()}`;
      const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
      const rawPath = `${userSub}/raw/${documentId}.${ext}`;
      const finalPath = `${userSub}/${ext === 'pdf' ? 'invoice' : 'receipt'}/${documentId}.${ext}`;

      // 1. Upload to S3 with Progress Tracking
      await uploadData({ 
        path: rawPath, 
        data: file,
        options: {
          onProgress: ({ transferredBytes, totalBytes }) => {
            if (totalBytes && isMounted.current) {
              setUploadProgress(Math.round((transferredBytes / totalBytes) * 100));
            }
          }
        }
      }).result;

      // 2. Create the exact record object with type-casting to satisfy the schema
      const newDocRecord = {
        userId: userSub,
        documentId: documentId,
        recordType: "DOCUMENT",
        status: "PROCESSING", 
        s3RawUri: `s3://account-ai-bh/${rawPath}`,
        s3FinalUri: `s3://account-ai-bh/${finalPath}`,
        createdAt: new Date().toISOString()
      } as Schema["DocumentRecord"]["type"]; // <-- Type assertion fixes the setDocuments error

      // 3. TRUE OPTIMISTIC UI: Instantly update React state before AppSync finishes
      if (isMounted.current) {
        setDocuments(prev => [newDocRecord, ...prev]);
        setIsUploading(false);
        setUploadProgress(0);
        setActiveTab("library"); 
      }

      // 4. Send the creation command to AppSync in the background
      await client.models.DocumentRecord.create(newDocRecord);
      
    } catch (err) {
      console.error("Upload failed:", err);
      alert("Failed to upload document.");
      if (isMounted.current) setIsUploading(false);
    }
  };

  const handleValidateExtraction = async (doc: Schema["DocumentRecord"]["type"], formData: any) => {
    try {
      const [newCoaCode, newCoaName] = coaSearch.split(" - ");
      const newStatus = (doc.aiConfidenceScore ?? 100) < 90 || !doc.isMathValid 
        ? "CUSTOMER_APPROVED_FLAGGED" : "CUSTOMER_APPROVED_CLEAN";

      await client.models.DocumentRecord.update({
        userId: doc.userId,
        documentId: doc.documentId,
        status: newStatus, 
        extractedVendor: formData.vendorName,
        extractedTotal: formData.total ? parseFloat(formData.total) : null,
        extractedTax: formData.tax ? parseFloat(formData.tax) : null,
        extractedDate: formData.date || null,
        mappedAccountCode: newCoaCode || doc.mappedAccountCode,
        mappedAccountName: newCoaName || doc.mappedAccountName,
        accountantNote: null // <-- CLEAR NOTE SO IT DOES NOT PERSIST AFTER RESOLUTION
      });
      
      setSelectedDocument(null);
    } catch (err) {
      alert("Failed to save changes.");
    }
  };

  const handleViewDocument = async (doc: Schema["DocumentRecord"]["type"]) => {
    // 1. Prefer the final URI (invoice/receipt folder), fallback to raw if not processed yet
    const uri = doc.s3FinalUri || doc.s3RawUri;
    
    if (!uri) {
      alert("Document URL not found.");
      return;
    }
    
    try {
      // 2. Strip the bucket name
      let path = uri.replace("s3://account-ai-bh/", "");
      
      // 3. (Optional Hack) To make your EXISTING document work without re-uploading:
      if (path.includes("/raw/") && doc.status !== "PROCESSING") {
        path = path.replace("/raw/", "/invoice/");
      }

      // 4. Get the presigned URL and open it
      const linkToStorageFile = await getUrl({ path });
      window.open(linkToStorageFile.url.toString(), "_blank");
    } catch (err) {
      console.error(err);
      alert("Failed to fetch document link.");
    }
  };

  const pendingCount = documents.filter(d => d.status === "PENDING_CUSTOMER").length;

  return (
    <main className="content">
      <nav className="nav-tabs">
        <button className={activeTab === "upload" ? "active-tab-btn" : "tab-btn"} onClick={() => setActiveTab("upload")}>
          📤 Upload
        </button>
        <button className={activeTab === "library" ? "active-tab-btn" : "tab-btn"} onClick={() => setActiveTab("library")}>
          📁 Library {pendingCount > 0 && <span style={{ color: "red", fontWeight: "bold" }}>({pendingCount} Action Required)</span>}
        </button>
        <button className={activeTab === "setup" ? "active-tab-btn" : "tab-btn"} onClick={() => setActiveTab("setup")}>
          ⚙️ Setup
        </button>
      </nav>

      {/* --- SETUP TAB --- */}
      {activeTab === "setup" && (
        <div style={{ marginTop: "2rem" }}>
          <h2>Company Configuration</h2>
          <p>Define your company details and custom Chart of Accounts (COA) to train the AI Agent.</p>
          <form onSubmit={handleSaveProfile} className="card">
            <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", marginBottom: "2rem" }}>
              <div className="form-group"><label>Company Name</label><input value={companyName} onChange={e => setCompanyName(e.target.value)} className="input" /></div>
              <div className="form-group">
                <label>Entity Type</label>
                <select value={companyType} onChange={e => setCompanyType(e.target.value)} className="input">
                  <option value="WLL">WLL</option><option value="LLC">LLC</option>
                  <option value="EST">EST</option><option value="SPC">SPC</option>
                </select>
              </div>
              <div className="form-group"><label>Company TRN (VAT ID)</label><input value={companyTrn} onChange={e => setCompanyTrn(e.target.value)} className="input" /></div>
              <div className="form-group" style={{ width: "100%" }}><label>Registered Address</label><input value={companyAddress} onChange={e => setCompanyAddress(e.target.value)} className="input" style={{ width: "100%" }} /></div>
            </div>

            <div style={{ background: "#f8f9fa", padding: "1.5rem", borderRadius: "8px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <h3 style={{ margin: 0 }}>Chart of Accounts</h3>
                <p style={{ margin: 0, color: "#666" }}>You have {coaList.length} custom account codes configured.</p>
              </div>
              <button type="button" onClick={() => setIsCoaModalOpen(true)} className="secondary-btn">
                Manage Chart of Accounts
              </button>
            </div>
            
            <button type="submit" className="success-btn" style={{ marginTop: "2rem" }}>Save Configuration</button>
          </form>
        </div>
      )}

      {/* --- UPLOAD TAB --- */}
      {activeTab === "upload" && (
  <div className="upload-box" style={{ marginTop: "2rem", textAlign: "center", padding: "3rem", background: "white", borderRadius: "12px", boxShadow: "0 2px 4px rgba(0,0,0,0.05)" }}>
    <h2>Upload Financial Document</h2>
    <p style={{ color: "#64748b", marginBottom: "1.5rem" }}>Upload invoices or receipts for automated AI extraction.</p>
    
    <input 
      type="file" 
      accept="application/pdf,image/*" 
      onChange={handleFileUpload} 
      disabled={isUploading} 
      style={{ marginBottom: "1.5rem" }}
    />

    {/* 🟢 THIS READS uploadProgress AND RESOLVES THE COMPILER WARNING */}
    {isUploading && (
      <div style={{ width: "100%", maxWidth: "400px", margin: "0 auto" }}>
        <p style={{ fontWeight: "bold", color: "#4f46e5", marginBottom: "0.5rem" }}>
          Uploading to S3... {uploadProgress}%
        </p>
        <div style={{ width: "100%", backgroundColor: "#e2e8f0", borderRadius: "8px", overflow: "hidden", height: "12px" }}>
          <div style={{ 
            width: `${uploadProgress}%`, 
            backgroundColor: "#4f46e5", 
            height: "100%", 
            transition: "width 0.2s ease-in-out" 
          }} />
        </div>
      </div>
    )}
  </div>
)}

      {/* --- LIBRARY TAB --- */}
      {activeTab === "library" && (
        <div style={{ marginTop: "2rem" }}>
          <h2>My Document History</h2>
          <table className="table" style={{ width: "100%", textAlign: "left", marginTop: "1rem" }}>
            <thead>
              <tr style={{ background: "#f5f5f5" }}>
                <th>ID</th><th>Vendor</th><th>Date</th><th>Total</th><th>Category</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => (
                <tr 
                  key={doc.documentId} 
                  onClick={() => {
                    setSelectedDocument(doc);
                    // Pre-fill the custom search state when the modal opens
                    setCoaSearch(doc.mappedAccountCode ? `${doc.mappedAccountCode} - ${doc.mappedAccountName}` : "");
                  }}
                  style={{ 
                    borderBottom: "1px solid #eee", 
                    cursor: "pointer",
                    backgroundColor: doc.status === "PENDING_CUSTOMER" ? "#fff9e6" : "inherit"
                  }}
                  onMouseOver={(e) => e.currentTarget.style.backgroundColor = "#f0f8ff"}
                  onMouseOut={(e) => e.currentTarget.style.backgroundColor = doc.status === "PENDING_CUSTOMER" ? "#fff9e6" : "inherit"}
                >
                  <td style={{ padding: "12px 8px" }}>{doc.documentId}</td>
                  <td>{doc.extractedVendor || "Processing..."}</td>
                  <td>{doc.extractedDate || "-"}</td>
                  <td>{doc.extractedTotal ? `$${doc.extractedTotal}` : "-"}</td>
                  <td>{doc.mappedAccountName || "-"}</td>
                  <td><span className="badge">{doc.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* --- DOCUMENT REVIEW MODAL --- */}
      {selectedDocument && (
        <div style={{
          position: "fixed", top: 0, left: 0, width: "100vw", height: "100vh",
          backgroundColor: "rgba(0,0,0,0.6)", display: "flex", justifyContent: "center", alignItems: "center", zIndex: 1000
        }}>
          <div style={{
            background: "white", padding: "2rem", borderRadius: "12px", width: "90%", maxWidth: "600px",
            maxHeight: "90vh", overflowY: "auto", boxShadow: "0 10px 25px rgba(0,0,0,0.2)"
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
              <h2 style={{ margin: 0 }}>Document: {selectedDocument.documentId}</h2>
              <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
                <button 
  type="button" 
  onClick={() => handleViewDocument(selectedDocument)} // <-- PASS THE OBJECT
  style={{ 
    fontSize: "0.75rem", padding: "4px 8px", backgroundColor: "#f1f5f9", 
    border: "1px solid #cbd5e1", borderRadius: "4px", cursor: "pointer", color: "#334155"
  }}
>
  👁️ View Original
</button>
                <button onClick={() => setSelectedDocument(null)} style={{ background: "none", border: "none", fontSize: "1.5rem", cursor: "pointer", color: "#64748b" }}>✖</button>
              </div>
            </div>

            {selectedDocument.status === "PENDING_CUSTOMER" ? (
              <form onSubmit={(e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                handleValidateExtraction(selectedDocument, {
                  vendorName: fd.get("vendorName"), total: fd.get("total"), tax: fd.get("tax"), date: fd.get("date")
                });
              }}>
                {selectedDocument.accountantNote ? (
  <div style={{ backgroundColor: "#fef3c7", borderLeft: "4px solid #f59e0b", padding: "1rem", borderRadius: "8px", marginBottom: "1.5rem" }}>
    <strong style={{ color: "#92400e", fontSize: "1rem" }}>⚠️ Accountant Feedback:</strong>
    <p style={{ margin: "0.5rem 0 0 0", color: "#78350f", fontWeight: "600", fontSize: "0.95rem" }}>
      "{selectedDocument.accountantNote}"
    </p>
  </div>
) : (
  <div style={{ backgroundColor: "#e0f2fe", padding: "1rem", borderRadius: "8px", marginBottom: "1.5rem" }}>
    <strong>Action Required:</strong> Please verify the AI extracted data below.
  </div>
)}

                <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
                  <div className="form-group"><label>Vendor</label><input name="vendorName" defaultValue={selectedDocument.extractedVendor || ""} className="input" /></div>
                  <div className="form-group"><label>Date</label><input name="date" defaultValue={selectedDocument.extractedDate || ""} className="input" /></div>
                  <div className="form-group"><label>Total</label><input name="total" type="number" step="0.01" defaultValue={selectedDocument.extractedTotal || ""} className="input" /></div>
                  <div className="form-group"><label>Tax</label><input name="tax" type="number" step="0.01" defaultValue={selectedDocument.extractedTax || ""} className="input" /></div>

                  {/* CUSTOM SEARCHABLE DROPDOWN (Replacing datalist) */}
                  <div className="form-group" style={{ flexBasis: "100%", marginTop: "1rem", position: "relative" }}>
                    <label style={{ fontWeight: "bold", color: "#4f46e5", display: "block", marginBottom: "0.5rem" }}>✨ AI Proposed Category (COA)</label>
                    <input 
                      type="text"
                      value={coaSearch}
                      onChange={(e) => {
                        setCoaSearch(e.target.value);
                        setShowCoaDropdown(true);
                      }}
                      onFocus={() => setShowCoaDropdown(true)}
                      onBlur={() => setTimeout(() => setShowCoaDropdown(false), 200)} // Delay hides list so clicks register
                      className="input" 
                      placeholder="Start typing COA code or name..." 
                      autoComplete="off"
                      style={{ width: "100%", boxSizing: "border-box", padding: "0.75rem", fontSize: "1rem" }}
                    />
                    
                    {showCoaDropdown && (
                      <div style={{
                        position: "absolute", top: "100%", left: 0, right: 0,
                        backgroundColor: "#ffffff", border: "1px solid #cbd5e1", 
                        borderRadius: "0 0 8px 8px", zIndex: 50, maxHeight: "180px", 
                        overflowY: "auto", boxShadow: "0 4px 6px -1px rgba(0,0,0,0.1)"
                      }}>
                        {coaList
                          .filter(c => `${c.code} - ${c.name}`.toLowerCase().includes(coaSearch.toLowerCase()))
                          .map(c => (
                            <div 
                              key={c.code} 
                              onClick={() => {
                                setCoaSearch(`${c.code} - ${c.name}`);
                                setShowCoaDropdown(false);
                              }}
                              style={{ padding: "0.75rem", cursor: "pointer", borderBottom: "1px solid #f1f5f9", color: "#000" }}
                              onMouseOver={(e) => e.currentTarget.style.backgroundColor = "#f1f5f9"}
                              onMouseOut={(e) => e.currentTarget.style.backgroundColor = "transparent"}
                            >
                              {c.code} - {c.name}
                            </div>
                        ))}
                        {coaList.filter(c => `${c.code} - ${c.name}`.toLowerCase().includes(coaSearch.toLowerCase())).length === 0 && (
                          <div style={{ padding: "0.75rem", color: "#64748b", fontStyle: "italic" }}>No matching account codes found.</div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                
                <div style={{ display: "flex", justifyContent: "flex-end", gap: "1rem", marginTop: "2rem" }}>
                  <button type="button" onClick={() => setSelectedDocument(null)} className="secondary-btn">Cancel</button>
                  <button type="submit" className="success-btn">Approve & Send to Accountant</button>
                </div>
              </form>
            ) : (
              <div>
                <div style={{ display: "flex", gap: "1rem", marginBottom: "1.5rem" }}>
                  <span className="badge">{selectedDocument.status}</span>
                </div>
                <table style={{ width: "100%", textAlign: "left", lineHeight: "2" }}>
                  <tbody>
                    <tr><th style={{ width: "150px" }}>Vendor:</th><td>{selectedDocument.extractedVendor || "-"}</td></tr>
                    <tr><th>Date:</th><td>{selectedDocument.extractedDate || "-"}</td></tr>
                    <tr><th>Total:</th><td>{selectedDocument.extractedTotal ? `$${selectedDocument.extractedTotal}` : "-"}</td></tr>
                    <tr><th>Tax:</th><td>{selectedDocument.extractedTax ? `$${selectedDocument.extractedTax}` : "-"}</td></tr>
                    <tr><th>Category (COA):</th><td>{selectedDocument.mappedAccountCode ? `${selectedDocument.mappedAccountCode} - ${selectedDocument.mappedAccountName}` : "-"}</td></tr>
                  </tbody>
                </table>
                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "2rem" }}>
                  <button onClick={() => setSelectedDocument(null)} className="secondary-btn">Close</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* --- COA CONFIG MODAL OVERLAY --- */}
      {isCoaModalOpen && (
        <div style={{
          position: "fixed", top: 0, left: 0, width: "100vw", height: "100vh",
          backgroundColor: "rgba(0,0,0,0.5)", display: "flex", justifyContent: "center", alignItems: "center", zIndex: 1000
        }}>
          <div style={{
            background: "white", padding: "2rem", borderRadius: "12px", width: "90%", maxWidth: "600px",
            maxHeight: "80vh", overflowY: "auto", boxShadow: "0 10px 25px rgba(0,0,0,0.2)"
          }}>
            <h2 style={{ marginTop: 0 }}>Chart of Accounts Editor</h2>
            <p style={{ color: "#666" }}>These codes are sent securely to the AI Agent during extraction.</p>
            
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginTop: "1.5rem" }}>
              {coaList.map((coa, i) => (
                <div key={i} style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
                  <input placeholder="Code (e.g. 6100)" value={coa.code} onChange={e => updateCoa(i, "code", e.target.value)} className="input" style={{ width: "100px" }} />
                  <input placeholder="Account Name (e.g. Advertising)" value={coa.name} onChange={e => updateCoa(i, "name", e.target.value)} className="input" style={{ flex: 1 }} />
                  <button type="button" onClick={() => removeCoa(i)} style={{ color: "#dc3545", background: "none", border: "none", cursor: "pointer", fontWeight: "bold" }}>✖</button>
                </div>
              ))}
            </div>

            <button type="button" onClick={addCoa} className="secondary-btn" style={{ marginTop: "1rem", width: "100%" }}>+ Add New Account Code</button>
            
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "2rem" }}>
              <button type="button" onClick={() => setIsCoaModalOpen(false)} className="success-btn">Done</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}