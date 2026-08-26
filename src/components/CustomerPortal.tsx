import { useEffect, useState, useRef, useMemo } from "react";
import type { Schema } from "../../amplify/data/resource";
import { generateClient } from "aws-amplify/data";
import { fetchAuthSession } from "aws-amplify/auth";
import { uploadData, getUrl, list } from "aws-amplify/storage";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import ChatAssistant from './ChatAssistant';

const client = generateClient<Schema>();

// 🟢 BUILT-IN FALLBACK LIST
const FALLBACK_COA_LIST = [
  { code: "1000", name: "ASSETS" }, { code: "1100", name: "Cash on Hand" }, { code: "1110", name: "Petty Cash" },
  { code: "1120", name: "Bank Account" }, { code: "1130", name: "Short-term Deposits" }, { code: "1200", name: "Accounts Receivable" },
  { code: "1210", name: "Allowance for Doubtful Accounts" }, { code: "1300", name: "Inventory" }, { code: "1310", name: "Raw Materials" },
  { code: "1320", name: "Work in Progress" }, { code: "1330", name: "Finished Goods" }, { code: "1400", name: "Prepaid Expenses" },
  { code: "1410", name: "Prepaid Insurance" }, { code: "1420", name: "Prepaid Rent" }, { code: "1500", name: "Fixed Assets" },
  { code: "1510", name: "Land" }, { code: "1520", name: "Buildings" }, { code: "1530", name: "Machinery & Equipment" },
  { code: "1540", name: "Office Equipment" }, { code: "1550", name: "Computers" }, { code: "1560", name: "Vehicles" },
  { code: "1590", name: "Accumulated Depreciation" }, { code: "2000", name: "LIABILITIES" }, { code: "2100", name: "Accounts Payable" },
  { code: "2110", name: "Trade Creditors" }, { code: "2200", name: "Accrued Expenses" }, { code: "2210", name: "Salaries Payable" },
  { code: "2220", name: "Utilities Payable" }, { code: "2230", name: "Taxes Payable" }, { code: "2300", name: "VAT/Sales Tax Payable" },
  { code: "2400", name: "Bank Loan - Short Term" }, { code: "2500", name: "Bank Loan - Long Term" }, { code: "2600", name: "Customer Deposits" },
  { code: "3000", name: "EQUITY" }, { code: "3100", name: "Owner's Capital" }, { code: "3200", name: "Additional Capital" },
  { code: "3300", name: "Retained Earnings" }, { code: "3400", name: "Current Year Earnings" }, { code: "3500", name: "Owner's Drawings" },
  { code: "4000", name: "REVENUE" }, { code: "4100", name: "Sales Revenue" }, { code: "4110", name: "Service Revenue" },
  { code: "4200", name: "Other Operating Income" }, { code: "4300", name: "Interest Income" }, { code: "4400", name: "Other Income" },
  { code: "5000", name: "COST OF SALES" }, { code: "5100", name: "Cost of Goods Sold" }, { code: "5110", name: "Purchases" },
  { code: "5120", name: "Freight In" }, { code: "5130", name: "Purchase Returns" }, { code: "5140", name: "Inventory Adjustments" },
  { code: "6000", name: "OPERATING EXPENSES" }, { code: "6100", name: "Salaries and Wages" }, { code: "6110", name: "Employee Benefits" },
  { code: "6200", name: "Rent Expense" }, { code: "6210", name: "Utilities Expense" }, { code: "6220", name: "Telephone & Internet" },
  { code: "6230", name: "Office Supplies" }, { code: "6240", name: "Repairs & Maintenance" }, { code: "6250", name: "Vehicle Expenses" },
  { code: "6260", name: "Fuel Expense" }, { code: "6270", name: "Insurance Expense" }, { code: "6280", name: "Depreciation Expense" },
  { code: "6290", name: "Travel & Entertainment" }, { code: "6300", name: "Marketing & Advertising" }, { code: "6310", name: "Professional Fees" },
  { code: "6320", name: "Bank Charges" }, { code: "6330", name: "Software Subscriptions" }, { code: "6340", name: "Training Expense" },
  { code: "6350", name: "Miscellaneous Expenses" }, { code: "7000", name: "FINANCE & TAX EXPENSES" }, { code: "7100", name: "Interest Expense" },
  { code: "7200", name: "Income Tax Expense" }, { code: "7300", name: "Foreign Exchange Gain/Loss" }
];

const parseCOA = (rawStr: any): {code: string, name: string}[] => {
  if (!rawStr) return [];
  let parsed = rawStr;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch (e) { return []; }
  }
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch (e) { return []; }
  }
  return Array.isArray(parsed) ? parsed : [];
};

const CHART_COLORS = ["#4F73EE", "#D77B9A", "#00A480", "#A881F3", "#E07715", "#80A2FF", "#E11D48", "#2563EB", "#059669", "#D97706"];

export default function CustomerPortal() {
  const [activeTab, setActiveTab] = useState<"upload" | "library" | "setup" | "analytics">("library");
  const [documents, setDocuments] = useState<Array<Schema["DocumentRecord"]["type"]>>([]);
  const [isUploading, setIsUploading] = useState(false);
  
  // --- CONFIG / SETUP STATE ---
  const [userSub, setUserSub] = useState<string>("");
  const [uploadProgress, setUploadProgress] = useState(0);
  const isMounted = useRef(true);
  const [customerProfile, setCustomerProfile] = useState<Schema["DocumentRecord"]["type"] | null>(null);
  
  const [companyName, setCompanyName] = useState("");
  const [companyType, setCompanyType] = useState("WLL");
  const [companyAddress, setCompanyAddress] = useState("");
  const [companyTrn, setCompanyTrn] = useState("");
  const [selectedAccountantSub, setSelectedAccountantSub] = useState<string>("");
  
  // --- ACCOUNTANT STATE ---
  const [availableAccountants, setAvailableAccountants] = useState<Array<Schema["DocumentRecord"]["type"]>>([]);
  
  // --- COA STATE & MODALS ---
  const [coaList, setCoaList] = useState<{ code: string; name: string }[]>([]);
  const [systemCoaList, setSystemCoaList] = useState<{ code: string; name: string }[]>([]); 
  const [isCoaModalOpen, setIsCoaModalOpen] = useState(false);
  const [focusedCoaIndex, setFocusedCoaIndex] = useState<number | null>(null);
  const [selectedDocument, setSelectedDocument] = useState<Schema["DocumentRecord"]["type"] | null>(null);

  // --- DROPDOWN STATE ---
  const [coaSearch, setCoaSearch] = useState("");
  const [showCoaDropdown, setShowCoaDropdown] = useState(false);
  const [editForm, setEditForm] = useState({ vendorName: "", date: "", total: "", tax: "" });
  const [isApproving, setIsApproving] = useState(false);
  const [docToDelete, setDocToDelete] = useState<Schema["DocumentRecord"]["type"] | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  // --- CHAT STATE ---
  const [isChatOpen, setIsChatOpen] = useState(false);

  // --- CHAT WIDGET STATE ---
  // isMobileChatOpen controls the universal chat widget (FAB ↔ panel/modal).
  // CSS handles desktop-vs-mobile presentation — no JS breakpoint needed.
  const [isMobileChatOpen, setIsMobileChatOpen] = useState(false);

  // --- REPORTS STATE ---
  const [reportFiles, setReportFiles] = useState<any[]>([]);
  const [isLoadingReports, setIsLoadingReports] = useState(false);
  const [isSavingProfile, setIsSavingProfile] = useState(false);

  // 1. Strict Derived Validation State
  const isFormValid = useMemo(() => {
    const isNameValid = companyName.trim().length > 0;
    const isTypeValid = companyType.trim().length > 0;
    const isTrnValid = companyTrn.trim().length > 0;
    const isAddressValid = companyAddress.trim().length > 0;
    const isAccountantSelected = selectedAccountantSub.trim().length > 0;
    
    return isNameValid && isTypeValid && isTrnValid && isAddressValid && isAccountantSelected;
  }, [companyName, companyType, companyTrn, companyAddress, selectedAccountantSub]);

  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  // 2. Fetch Accountants
  useEffect(() => {
    const fetchAccountants = async () => {
      try {
        const { data, errors } = await client.models.DocumentRecord.list(
          {
            filter: { recordType: { eq: "PROFILE_ACC" } },
            authMode: "apiKey",
          }
        );
        if (errors && errors.length > 0) {
          console.error("fetchAccountants errors:", errors);
          return;
        }
        if (isMounted.current) setAvailableAccountants(data || []);
      } catch (err) {
        console.error("Failed to fetch accountants:", err);
      }
    };
    fetchAccountants();
  }, []);

  // 3. 🟢 EVENT-DRIVEN STRATEGY: Initial Fetch + Pub/Sub Listeners
  // 3. 🟢 REAL-TIME EVENT-DRIVEN STRATEGY: observeQuery
  useEffect(() => {
    let subscription: any;

    const fetchSystemCOA = async () => {
      try {
        const { data } = await client.models.DocumentRecord.get(
          { userId: "SYSTEM", documentId: "DEFAULT_COA" },
          { authMode: "apiKey" } 
        );
        if (data?.chartOfAccounts && isMounted.current) {
          setSystemCoaList(parseCOA(data.chartOfAccounts));
        }
      } catch (err) {
        console.error("Failed to fetch System COA, relying on local fallback.", err);
      }
    };

    const initializePortal = async () => {
      try {
        const session = await fetchAuthSession();
        const sub = session.tokens?.idToken?.payload.sub?.toString();
        if (!sub) return;

        if (isMounted.current) setUserSub(sub);

        // 🟢 NEW: Real-time sync replaces manual fetching and individual listeners
        subscription = client.models.DocumentRecord.observeQuery({
          filter: { userId: { eq: sub } }
        }).subscribe({
          next: ({ items }) => {
            if (!isMounted.current) return;

            // Separate the customer profile config from the actual invoices
            const profile = items.find(d => d.documentId === "CUST");
            const docs = items.filter(d => d.documentId !== "CUST");

            // Automatically sort the live documents (newest first) and update UI
            setDocuments([...docs].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")));

            // Update customer profile state if it exists
            if (profile) {
              setCustomerProfile(profile);
              setCompanyName(profile.companyName || "");
              setCompanyType(profile.companyType || "WLL");
              setCompanyAddress(profile.companyAddress || "");
              setCompanyTrn(profile.companyTrn || "");
              setSelectedAccountantSub(profile.accountantId || "");
              setCoaList(parseCOA(profile.chartOfAccounts));
            }
          },
          error: (error) => console.warn("Real-time sync error:", error)
        });

      } catch (err) {
        console.error("Failed to initialize customer portal:", err);
      }
    };

    fetchSystemCOA();
    initializePortal();

    // Clean up the websocket when the user navigates away
    return () => {
      if (subscription) subscription.unsubscribe();
    };
  }, []);

  const { chartData, chartCategories } = useMemo(() => {
    const finalizedDocs = documents.filter(d => d.status === "FINALIZED");
    const dataMap: Record<string, any> = {};
    const categories = new Set<string>();

    finalizedDocs.forEach(doc => {
      let parsedDate = new Date(doc.extractedDate || "");
      if (isNaN(parsedDate.getTime())) {
        const parts = (doc.extractedDate || "").split('-');
        if (parts.length >= 3) {
           parsedDate = new Date(`${parts[1]} 1, ${parts[2]}`);
        }
      }
      
      const monthStr = isNaN(parsedDate.getTime()) 
        ? "Unknown Date" 
        : parsedDate.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

      const category = doc.mappedAccountName || "Uncategorized";
      const total = doc.extractedTotal || 0;

      categories.add(category);

      if (!dataMap[monthStr]) dataMap[monthStr] = { month: monthStr };
      dataMap[monthStr][category] = (dataMap[monthStr][category] || 0) + total;
    });

    const sortedData = Object.values(dataMap).sort((a: any, b: any) => {
      return new Date(a.month).getTime() - new Date(b.month).getTime();
    });

    return { chartData: sortedData, chartCategories: Array.from(categories) };
  }, [documents]);

  // 🟢 FETCH REPORTS FOR THE LOGGED-IN CUSTOMER
  const fetchReports = async () => {
    if (!userSub) return;
    setIsLoadingReports(true);
    try {
      // List all reports and filter strictly by the customer's Cognito SUB
      const result = await list({ path: `reports/` });
      const userReports = result.items.filter(
        item => item.path.includes(userSub) && item.size && item.size > 0
      );
      if (isMounted.current) setReportFiles(userReports);
    } catch (err) {
      console.error("Failed to fetch customer reports:", err);
      if (isMounted.current) setReportFiles([]);
    } finally {
      if (isMounted.current) setIsLoadingReports(false);
    }
  };

  useEffect(() => {
    if (activeTab === "analytics" && userSub) {
      fetchReports();
    }
  }, [activeTab, userSub, companyName]);

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userSub) {
      alert("Could not identify your account. Please refresh and try again.");
      return;
    }
    
    // Strict secondary validation intercept
    if (!isFormValid) {
      alert("Please fill in all required fields and select an accountant.");
      return;
    }

    setIsSavingProfile(true);
    try {
      const formattedCoa = JSON.stringify(coaList);
      
      const profilePayload = {
        userId: userSub,
        documentId: "CUST",
        recordType: "PROFILE_CUST",
        companyName,
        companyType,
        companyAddress,
        companyTrn,
        chartOfAccounts: formattedCoa,
        accountantId: selectedAccountantSub
      };

      let response;
      if (customerProfile) {
        response = await client.models.DocumentRecord.update(profilePayload);
      } else {
        response = await client.models.DocumentRecord.create(profilePayload);
      }

      // AppSync strict error checking intercept
      if (response?.errors && Array.isArray(response.errors) && response.errors.length > 0) {
        console.error("❌ AppSync Mutation Failed - Errors:", response.errors);
        const errorMessage = response.errors[0]?.message || "Unknown GraphQL error";
        alert(`⚠️ Configuration Save Failed:\n\n${errorMessage}`);
        return; 
      }

      alert("Company Setup Saved!");
      
    } catch (err) {
      console.error("❌ Failed to save profile - Exception:", err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      alert(`Failed to save profile: ${errorMessage}`);
    } finally {
      if (isMounted.current) setIsSavingProfile(false);
    }
  };

  const addCoa = () => setCoaList([...coaList, { code: "", name: "" }]);
  const updateCoa = (index: number, field: "code" | "name", value: string) => {
    const updated = [...coaList]; updated[index][field] = value; setCoaList(updated);
  };
  const removeCoa = (index: number) => setCoaList(coaList.filter((_, i) => i !== index));

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    // 🟢 1. Convert the FileList into an Array to support multiple files
    const files = Array.from(event.target.files || []);
    if (files.length === 0 || !userSub) return;
    
    setIsUploading(true); 
    setUploadProgress(0); 
    
    try {
      // Calculate total size for an accurate aggregate progress bar
      const totalSize = files.reduce((acc, file) => acc + file.size, 0);
      let uploadedSize = 0;
      const newDocs: Array<Schema["DocumentRecord"]["type"]> = [];

      // 🟢 2. Loop through and upload each file sequentially
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        // Append index to timestamp to guarantee unique IDs if processed in the same millisecond
        const documentId = `doc-${Date.now()}-${i}`;
        const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
        const rawPath = `${userSub}/raw/${documentId}.${ext}`;

        await uploadData({ 
          path: rawPath, 
          data: file,
          options: {
            onProgress: ({ transferredBytes }) => {
              if (isMounted.current) {
                const overallTransferred = uploadedSize + transferredBytes;
                setUploadProgress(Math.round((overallTransferred / totalSize) * 100));
              }
            }
          }
        }).result;

        // Add the current file's size to the running total after it finishes
        uploadedSize += file.size;

        const newDocRecord = {
          userId: userSub, 
          documentId: documentId, 
          recordType: "DOCUMENT",
          status: "PROCESSING", 
          s3RawUri: `s3://account-ai-bh/${rawPath}`,
          accountantId: customerProfile?.accountantId || undefined,
          companyName: companyName
        } as Schema["DocumentRecord"]["type"];

        newDocs.push(newDocRecord);
        await client.models.DocumentRecord.create(newDocRecord);
      }

      // 🟢 3. Update the UI state once all files are uploaded
      if (isMounted.current) {
        setDocuments(prev => [...newDocs, ...prev]);
        setIsUploading(false); 
        setUploadProgress(0); 
        setActiveTab("library"); 
        
        // Reset the input so the user can select the same files again if needed
        event.target.value = '';
      }
    } catch (err) {
      console.error("Upload failed:", err);
      if (isMounted.current) setIsUploading(false);
    }
  };

  const handleViewDocument = async (doc: Schema["DocumentRecord"]["type"]) => {
    const uri = doc.s3FinalUri || doc.s3RawUri;
    if (!uri) return alert("Document URL not found.");
    try {
      let path = uri.replace("s3://account-ai-bh/", "");
      if (path.includes("/raw/") && doc.status !== "PROCESSING") path = path.replace("/raw/", "/invoice/");
      const linkToStorageFile = await getUrl({ path });
      window.open(linkToStorageFile.url.toString(), "_blank");
    } catch (err) {
      alert("Failed to fetch document link.");
    }
  };

  const pendingCount = documents.filter(d => d.status === "PENDING_CUSTOMER").length;
  const safeCoaList = Array.isArray(coaList) ? coaList : [];
  const safeSystemList = Array.isArray(systemCoaList) && systemCoaList.length > 0 ? systemCoaList : FALLBACK_COA_LIST;
  const activeCoaDropdownList = safeCoaList.length > 0 ? safeCoaList : safeSystemList;

  const renderLegend = (props: any) => {
    const { payload } = props;
    return (
      <ul style={{ listStyle: 'none', padding: 0, display: 'flex', flexWrap: 'wrap', gap: '15px', fontSize: '0.85rem', color: '#d1d5db', marginTop: '20px' }}>
        {payload.map((entry: any, index: number) => (
          <li key={`item-${index}`} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ width: '12px', height: '12px', backgroundColor: entry.color, borderRadius: '2px', display: 'inline-block' }}></span>
            {entry.value}
          </li>
        ))}
      </ul>
    );
  };

  return (
    <div className="dashboard-container">
      <nav className="nav-tabs">
        <button className={activeTab === "upload" ? "active-tab-btn" : "tab-btn"} onClick={() => setActiveTab("upload")}>📤 Upload</button>
        <button className={activeTab === "library" ? "active-tab-btn" : "tab-btn"} onClick={() => setActiveTab("library")}>
          📁 Library {pendingCount > 0 && <span style={{ color: "red", fontWeight: "bold" }}>({pendingCount} Action Required)</span>}
        </button>
        <button className={activeTab === "analytics" ? "active-tab-btn" : "tab-btn"} onClick={() => setActiveTab("analytics")}>📊 Analytics</button>
        <button className={activeTab === "setup" ? "active-tab-btn" : "tab-btn"} onClick={() => setActiveTab("setup")}>⚙️ Setup</button>
      </nav>
      <div className="dashboard-content-frame">

      {/* --- ANALYTICS TAB --- */}
      {activeTab === "analytics" && (
        <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
          <h2 style={{ margin: "0 0 0.25rem 0", flexShrink: 0 }}>Financial Analytics</h2>
          <p style={{ color: "#64748b", marginBottom: "2rem" }}>
            Live aggregated data from your finalized, accountant-approved transactions.
          </p>

          <div className="analytics-wrapper">
            
            <div className="chart-card" style={{ backgroundColor: '#161b22', color: '#e5e7eb' }}>
              <div style={{ marginBottom: '24px' }}>
                <h2 style={{ fontSize: '1.25rem', fontWeight: 'bold', margin: '0 0 16px 0', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 4px)', gap: '2px' }}>
                    <div style={{ width: '4px', height: '4px', backgroundColor: '#9ca3af', borderRadius: '1px' }}></div>
                    <div style={{ width: '4px', height: '4px', backgroundColor: '#9ca3af', borderRadius: '1px' }}></div>
                    <div style={{ width: '4px', height: '4px', backgroundColor: '#9ca3af', borderRadius: '1px' }}></div>
                    <div style={{ width: '4px', height: '4px', backgroundColor: '#9ca3af', borderRadius: '1px' }}></div>
                  </span>
                  Cost Breakdown by Category
                </h2>
              </div>

              <h3 style={{ fontSize: '0.9rem', fontWeight: '600', marginBottom: '16px', color: '#f3f4f6' }}>Costs (USD)</h3>

              <div className="chart-container" style={{ minHeight: 350 }}>
                {chartData.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData} margin={{ top: 0, right: 0, left: -10, bottom: 0 }} barSize={45}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#374151" />
                      <XAxis dataKey="month" axisLine={{ stroke: '#4b5563' }} tickLine={false} tick={{ fill: '#9ca3af', fontSize: '0.85rem' }} dy={10} />
                      <YAxis axisLine={false} tickLine={false} tick={{ fill: '#9ca3af', fontSize: '0.85rem' }} tickFormatter={(value) => `$${value}`} />
                      <Tooltip cursor={{ fill: '#1f2937' }} contentStyle={{ backgroundColor: '#1f2937', border: 'none', borderRadius: '6px', color: '#f3f4f6' }} itemStyle={{ color: '#f3f4f6' }} formatter={(value: any) => `$${(value as number).toFixed(2)}`} />
                      <Legend content={renderLegend} />
                      {chartCategories.map((cat, idx) => (
                        <Bar key={cat} dataKey={cat} name={cat} stackId="a" fill={CHART_COLORS[idx % CHART_COLORS.length]} />
                      ))}
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div style={{ height: "100%", display: "flex", justifyContent: "center", alignItems: "center", color: "#64748b" }}>
                    No finalized documents available to chart yet.
                  </div>
                )}
              </div>
            </div>

            <div className="reports-card">
              <h3 style={{ margin: "0 0 1rem 0", fontSize: "1.1rem", color: "#1e293b", borderBottom: "2px solid #e2e8f0", paddingBottom: "0.5rem" }}>
                📑 Period Reports
              </h3>
              
              {isLoadingReports ? (
                <p style={{ fontSize: "0.9rem", color: "#64748b" }}>Loading...</p>
              ) : reportFiles.length === 0 ? (
                <p style={{ fontSize: "0.9rem", color: "#64748b" }}>No CSV reports generated by accountant yet.</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                  {reportFiles.map((file, idx) => {
                    const cleanName = file.path.split('/').pop()?.replace("_POC.csv", "").replace(/_/g, " ") || "Report";
                    return (
                      <div key={idx} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0.75rem", backgroundColor: "white", borderRadius: "6px", boxShadow: "0 1px 2px rgba(0,0,0,0.05)" }}>
                        <span style={{ fontSize: "0.85rem", fontWeight: "600", color: "#334155" }}>
                          {cleanName}
                        </span>
                        <button 
                          title="Download CSV"
                          onClick={async () => {
                            const link = await getUrl({ path: file.path });
                            window.open(link.url.toString(), "_blank");
                          }}
                          style={{ background: "none", border: "none", fontSize: "1.25rem", cursor: "pointer", padding: "0" }}
                        >
                          📥
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            
          </div>
        </div>
      )}

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
              
              <div className="form-group" style={{ width: "100%" }}>
                <label htmlFor="accountant-select">Assigned Accountant</label>
                <select 
                  id="accountant-select"
                  value={selectedAccountantSub} 
                  onChange={e => setSelectedAccountantSub(e.target.value)} 
                  className="input"
                  style={{ width: "100%" }}
                >
                  <option value="">-- Select Your Accountant --</option>
                  {availableAccountants.map((accountant) => (
                    <option key={accountant.userId} value={accountant.userId || ""}>
                      {accountant.firmName || accountant.name || "Unnamed Accountant"}
                    </option>
                  ))}
                </select>
                <p style={{ margin: "0.5rem 0 0 0", color: "#666", fontSize: "0.9rem" }}>
                  Select the accounting firm that will review your documents
                </p>
              </div>
            </div>

            <div style={{ background: "#f8f9fa", padding: "1.5rem", borderRadius: "8px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <h3 style={{ margin: 0 }}>Chart of Accounts</h3>
                <p style={{ margin: 0, color: "#666" }}>
                  {safeCoaList.length > 0 
                    ? `You have ${safeCoaList.length} custom account codes configured.` 
                    : `Using Global System Default (${safeSystemList.length} codes). Click to override.`}
                </p>
              </div>
              <button type="button" onClick={() => setIsCoaModalOpen(true)} className="secondary-btn">Manage Chart of Accounts</button>
            </div>
            
            <button 
              type="submit" 
              className="success-btn" 
              style={{ 
                marginTop: "2rem",
                opacity: (!isFormValid || isSavingProfile) ? 0.5 : 1,
                cursor: (!isFormValid || isSavingProfile) ? "not-allowed" : "pointer"
              }} 
              disabled={!isFormValid || isSavingProfile}
              title={!isFormValid ? "Please fill in all required fields and select an accountant" : ""}
            >
              {isSavingProfile ? "Saving..." : "Save Configuration"}
            </button>
          </form>
        </div>
      )}

      {/* --- UPLOAD TAB --- */}
      {activeTab === "upload" && (
        <div className="upload-box" style={{ marginTop: "2rem", textAlign: "center", padding: "3rem", background: "white", borderRadius: "12px", boxShadow: "0 2px 4px rgba(0,0,0,0.05)" }}>
          <h2>Upload Financial Document</h2>
          <p style={{ color: "#64748b", marginBottom: "1.5rem" }}>Upload invoices or receipts for automated AI extraction.</p>
<input type="file" multiple accept="application/pdf,image/*" onChange={handleFileUpload} disabled={isUploading} style={{ marginBottom: "1.5rem" }} />
          {isUploading && (
            <div style={{ width: "100%", maxWidth: "400px", margin: "0 auto" }}>
              <p style={{ fontWeight: "bold", color: "#4f46e5", marginBottom: "0.5rem" }}>Uploading to S3... {uploadProgress}%</p>
              <div style={{ width: "100%", backgroundColor: "#e2e8f0", borderRadius: "8px", overflow: "hidden", height: "12px" }}>
                <div style={{ width: `${uploadProgress}%`, backgroundColor: "#4f46e5", height: "100%", transition: "width 0.2s ease-in-out" }} />
              </div>
            </div>
          )}
        </div>
      )}

      {/* --- LIBRARY TAB --- */}
      {activeTab === "library" && (
        <div style={{ marginTop: "2rem" }}>
          <h2>My Document History</h2>
          <div className="table-scroll-wrapper" style={{ marginTop: "1rem" }}>
          <table className="table" style={{ width: "100%", textAlign: "left" }}>
            <thead>
              <tr style={{ background: "#f5f5f5" }}>
                <th>ID</th><th>Vendor</th><th>Date</th><th>Total</th><th>Category</th><th>Status</th><th></th>
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => (
                <tr 
                 key={doc.documentId} 
                  onClick={() => {
                    setSelectedDocument(doc);
                    setCoaSearch(doc.mappedAccountCode ? `${doc.mappedAccountCode} - ${doc.mappedAccountName}` : "");
                    setEditForm({
                      vendorName: doc.extractedVendor || "", date: doc.extractedDate || "",
                      total: doc.extractedTotal?.toString() || "", tax: doc.extractedTax?.toString() || "",
                    });
                  }}
                  style={{ borderBottom: "1px solid #eee", cursor: "pointer", backgroundColor: doc.status === "PENDING_CUSTOMER" ? "#fff9e6" : "inherit" }}
                  onMouseOver={(e) => e.currentTarget.style.backgroundColor = "#f0f8ff"}
                  onMouseOut={(e) => e.currentTarget.style.backgroundColor = doc.status === "PENDING_CUSTOMER" ? "#fff9e6" : "inherit"}
                >
                  <td style={{ padding: "12px 8px" }}>{doc.documentId}</td>
                  <td>{doc.extractedVendor || "Processing..."}</td>
                  <td>{doc.extractedDate || "-"}</td>
                  <td>{doc.extractedTotal ? `$${doc.extractedTotal}` : "-"}</td>
                  <td>{doc.mappedAccountName || "-"}</td>
                  <td><span className="badge">{doc.status}</span></td>
                  <td style={{ textAlign: "center" }}>
  {/* 🟢 ADDED: "|| ''" to satisfy strict TypeScript validation */}
  {['PROCESSING', 'PENDING_CUSTOMER', 'PROCESSING_FAILED'].includes(doc.status || '') && (
    <button
      onClick={(e) => {
        e.stopPropagation(); 
        setDocToDelete(doc);
      }}
      style={{ background: "none", border: "none", cursor: "pointer", fontSize: "1.2rem" }}
      title="Delete Document"
    >
      🗑️
    </button>
  )}
</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {/* --- DOCUMENT REVIEW MODAL --- */}
      {selectedDocument && (
        <div style={{
          position: "fixed", top: 0, left: 0, width: "100vw", height: "100vh",
          backgroundColor: "rgba(0,0,0,0.6)", display: "flex", justifyContent: "center", alignItems: "center", zIndex: 1000
        }}>
          <div style={{
            background: "white", padding: "2rem", borderRadius: "12px", width: "90%", maxWidth: isChatOpen ? "1200px" : "600px",
            maxHeight: "90vh", overflowY: "auto", boxShadow: "0 10px 25px rgba(0,0,0,0.2)",
            display: isChatOpen ? "flex" : "block", gap: isChatOpen ? "2rem" : "0", flexDirection: isChatOpen ? "row" : "column"
          }}>
            <div style={{ flex: isChatOpen ? "0 0 60%" : "1", overflowY: isChatOpen ? "auto" : "visible", maxHeight: isChatOpen ? "calc(90vh - 4rem)" : "auto" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
                <h2 style={{ margin: 0 }}>Document: {selectedDocument.documentId}</h2>
                <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
                  <button type="button" onClick={() => handleViewDocument(selectedDocument)} style={{ fontSize: "0.75rem", padding: "4px 8px", backgroundColor: "#f1f5f9", border: "1px solid #cbd5e1", borderRadius: "4px", cursor: "pointer", color: "#334155" }}>👁️ View Original</button>
                  {/* <button type="button" onClick={() => setIsChatOpen(!isChatOpen)} style={{ fontSize: "0.75rem", padding: "4px 8px", backgroundColor: isChatOpen ? "#e0d7f7" : "#f1f5f9", border: "1px solid #cbd5e1", borderRadius: "4px", cursor: "pointer", color: isChatOpen ? "#6366f1" : "#334155" }}>🤖 Ask AI Agent</button> */}
                  <button onClick={() => { setSelectedDocument(null); setIsChatOpen(false); }} style={{ background: "none", border: "none", fontSize: "1.5rem", cursor: "pointer", color: "#64748b" }}>✖</button>
                </div>
              </div>

              {selectedDocument.status === "PENDING_CUSTOMER" ? (
                <form onSubmit={async (e) => {
                  e.preventDefault();
                  if (!selectedDocument) return;
                  setIsApproving(true);
                  try {
                    const [newCoaCode, newCoaName] = coaSearch.split(" - ");
                    const newStatus = (selectedDocument.aiConfidenceScore ?? 100) < 90 || !selectedDocument.isMathValid ? "CUSTOMER_APPROVED_FLAGGED" : "CUSTOMER_APPROVED_CLEAN";

                    await client.models.DocumentRecord.update({
                      userId: selectedDocument.userId, 
                      documentId: selectedDocument.documentId, 
                      status: newStatus,
                      companyName: companyName,
                      companyTrn: companyTrn,
                      extractedVendor: editForm.vendorName, 
                      extractedTotal: editForm.total ? parseFloat(editForm.total) : null,
                      extractedTax: editForm.tax ? parseFloat(editForm.tax) : null, 
                      extractedDate: editForm.date || null,
                      mappedAccountCode: newCoaCode || selectedDocument.mappedAccountCode, 
                      mappedAccountName: newCoaName || selectedDocument.mappedAccountName, 
                      accountantNote: null 
                    });
                    setSelectedDocument(null);
                    setIsChatOpen(false);
                  } catch (err) { alert("Failed to save changes."); } finally { setIsApproving(false); }
                }}>
                  {selectedDocument.accountantNote ? (
                    <div style={{ backgroundColor: "#fef3c7", borderLeft: "4px solid #f59e0b", padding: "1rem", borderRadius: "8px", marginBottom: "1.5rem" }}>
                      <strong style={{ color: "#92400e", fontSize: "1rem" }}>⚠️ Accountant Feedback:</strong>
                      <p style={{ margin: "0.5rem 0 0 0", color: "#78350f", fontWeight: "600", fontSize: "0.95rem" }}>"{selectedDocument.accountantNote}"</p>
                    </div>
                  ) : (
                    <div style={{ backgroundColor: "#e0f2fe", padding: "1rem", borderRadius: "8px", marginBottom: "1.5rem" }}>
                      <strong>Action Required:</strong> Please verify the AI extracted data below.
                    </div>
                  )}

                  <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
                    <div className="form-group"><label>Vendor</label><input value={editForm.vendorName} onChange={e => setEditForm({...editForm, vendorName: e.target.value})} className="input" /></div>
                    <div className="form-group"><label>Date</label><input value={editForm.date} onChange={e => setEditForm({...editForm, date: e.target.value})} className="input" /></div>
                    <div className="form-group"><label>Total</label><input type="number" step="0.01" value={editForm.total} onChange={e => setEditForm({...editForm, total: e.target.value})} className="input" /></div>
                    <div className="form-group"><label>Tax</label><input type="number" step="0.01" value={editForm.tax} onChange={e => setEditForm({...editForm, tax: e.target.value})} className="input" /></div>

                    <div className="form-group" style={{ flexBasis: "100%", marginTop: "1rem", position: "relative" }}>
                      <label style={{ fontWeight: "bold", color: "#4f46e5", display: "block", marginBottom: "0.5rem" }}>✨ AI Proposed Category (COA)</label>
                      <input 
                        type="text" value={coaSearch}
                        onChange={(e) => { setCoaSearch(e.target.value); setShowCoaDropdown(true); }}
                        onFocus={() => setShowCoaDropdown(true)}
                        onBlur={() => setTimeout(() => setShowCoaDropdown(false), 200)}
                        className="input" placeholder="Start typing COA code or name..." autoComplete="off"
                        style={{ width: "100%", boxSizing: "border-box", padding: "0.75rem", fontSize: "1rem" }}
                      />
                      
                      {showCoaDropdown && (
                        <div style={{
                          position: "absolute", top: "100%", left: 0, right: 0, backgroundColor: "#ffffff", border: "1px solid #cbd5e1", 
                          borderRadius: "0 0 8px 8px", zIndex: 50, maxHeight: "180px", overflowY: "auto", boxShadow: "0 4px 6px -1px rgba(0,0,0,0.1)"
                        }}>
                          {activeCoaDropdownList
                            .filter(c => `${c.code} - ${c.name}`.toLowerCase().includes(coaSearch.toLowerCase()))
                            .map(c => (
                              <div 
                                key={c.code} 
                                onMouseDown={(e) => { e.preventDefault(); setCoaSearch(`${c.code} - ${c.name}`); setShowCoaDropdown(false); }}
                                style={{ padding: "0.75rem", cursor: "pointer", borderBottom: "1px solid #f1f5f9", color: "#000" }}
                                onMouseOver={(e) => e.currentTarget.style.backgroundColor = "#f1f5f9"}
                                onMouseOut={(e) => e.currentTarget.style.backgroundColor = "transparent"}
                              >
                                {c.code} - {c.name}
                              </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: "1rem", marginTop: "2rem" }}>
                    <button type="button" onClick={() => { setSelectedDocument(null); setIsChatOpen(false); }} className="secondary-btn" disabled={isApproving}>Cancel</button>
                    <button type="submit" className="success-btn" disabled={isApproving}>{isApproving ? "Approving..." : "Approve & Send to Accountant"}</button>
                  </div>
                </form>
              ) : (
                <div>
                  <div style={{ display: "flex", gap: "1rem", marginBottom: "1.5rem" }}><span className="badge">{selectedDocument.status}</span></div>
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
                    <button onClick={() => { setSelectedDocument(null); setIsChatOpen(false); }} className="secondary-btn">Close</button>
                  </div>
                </div>
              )}
            </div>

            {isChatOpen && (
              <div style={{ flex: "0 0 40%", display: "flex", flexDirection: "column", minHeight: "0", overflow: "hidden" }}>
                <ChatAssistant
                  viewerRole="CUSTOMER"
                  customerId={userSub}
                  accountantId={selectedDocument.accountantId || 'GLOBAL'}
                  documentId={selectedDocument.documentId}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* --- DELETION CONFIRMATION MODAL --- */}
      {docToDelete && (
        <div style={{
          position: "fixed", top: 0, left: 0, width: "100vw", height: "100vh",
          backgroundColor: "rgba(0,0,0,0.5)", display: "flex", justifyContent: "center", alignItems: "center", zIndex: 1050
        }}>
          <div style={{ background: "white", padding: "2rem", borderRadius: "12px", width: "90%", maxWidth: "400px", textAlign: "center", boxShadow: "0 10px 25px rgba(0,0,0,0.2)" }}>
            <h3 style={{ margin: "0 0 1rem 0", color: "#0f172a" }}>Delete Document?</h3>
            <p style={{ color: "#64748b", marginBottom: "2rem" }}>
              Are you sure you want to delete document <strong>{docToDelete.documentId}</strong>? This action cannot be undone.
            </p>
            <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem" }}>
              <button
                className="secondary-btn"
                onClick={() => setDocToDelete(null)}
                disabled={isDeleting}
                style={{ flex: 1 }}
              >
                Cancel
              </button>
              <button
  className="success-btn"
  disabled={isDeleting}
  style={{ flex: 1, backgroundColor: "#ef4444" }}
  onClick={async () => {
    setIsDeleting(true);
    
    // 🟢 OPTIMISTIC UPDATE: Instantly remove the row from the UI before waiting for AWS
    setDocuments(prev => prev.filter(d => d.documentId !== docToDelete.documentId));
    
    try {
      await client.models.DocumentRecord.delete({
        userId: docToDelete.userId,
        documentId: docToDelete.documentId
      });
      setDocToDelete(null); // Close the validation modal
    } catch (err) {
      alert("Failed to delete document. Check your connection.");
      console.error(err);
    } finally {
      setIsDeleting(false);
    }
  }}
>
  {isDeleting ? "Deleting..." : "Yes, Delete"}
</button>
            </div>
          </div>
        </div>
      )}

      </div>{/* end .dashboard-content-frame */}

      {/* ── Global Chat Widget — FAB + fullscreen modal ── */}
      {!isMobileChatOpen ? (
        <button
          className="chat-fab"
          onClick={() => setIsMobileChatOpen(true)}
          aria-label="Open AI Assistant"
        >
          💬
        </button>
      ) : (
        <div className="chat-modal-fullscreen" role="dialog" aria-modal="true" aria-label="AI Assistant">
          <ChatAssistant
            viewerRole="CUSTOMER"
            customerId={userSub}
            accountantId={selectedAccountantSub || 'GLOBAL'}
            documentId={selectedDocument?.documentId || 'dashboard_general'}
            onClose={() => setIsMobileChatOpen(false)}
          />
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
              {safeCoaList.map((coa, i) => {
                const searchStr = `${coa.code} ${coa.name}`.toLowerCase().trim();
                const searchTerms = searchStr.split(" ").filter(t => t !== "");
                const suggestions = safeSystemList.filter(c => {
                  if (searchTerms.length === 0) return true;
                  const targetStr = `${c.code} ${c.name}`.toLowerCase();
                  return searchTerms.every(term => targetStr.includes(term));
                });

                return (
                  <div key={i} style={{ position: "relative" }} onFocusCapture={() => setFocusedCoaIndex(i)} onBlurCapture={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setFocusedCoaIndex(null); }}>
                    <div style={{ display: "flex", gap: "1rem", alignItems: "center", marginBottom: "0.5rem" }}>
                      <input placeholder="Code" value={coa.code} onChange={e => updateCoa(i, "code", e.target.value)} className="input" style={{ width: "100px" }} autoComplete="off" />
                      <input placeholder="Account Name" value={coa.name} onChange={e => updateCoa(i, "name", e.target.value)} className="input" style={{ flex: 1 }} autoComplete="off" />
                      <button type="button" onClick={() => removeCoa(i)} style={{ color: "#dc3545", background: "none", border: "none", cursor: "pointer", fontWeight: "bold" }}>✖</button>
                    </div>

                    {focusedCoaIndex === i && (
                      <div style={{ position: "absolute", top: "100%", left: 0, right: "32px", backgroundColor: "#ffffff", border: "1px solid #cbd5e1", borderRadius: "0 0 8px 8px", zIndex: 1050, maxHeight: "180px", overflowY: "auto", boxShadow: "0 4px 6px -1px rgba(0,0,0,0.2)" }}>
                        {suggestions.length > 0 ? (
                          suggestions.map(c => (
                            <div key={c.code} onMouseDown={(e) => { e.preventDefault(); updateCoa(i, "code", c.code); updateCoa(i, "name", c.name); setFocusedCoaIndex(null); }} style={{ padding: "0.75rem", cursor: "pointer", borderBottom: "1px solid #f1f5f9", color: "#334155", fontSize: "0.95rem" }} onMouseOver={(e) => e.currentTarget.style.backgroundColor = "#e0e7ff"} onMouseOut={(e) => e.currentTarget.style.backgroundColor = "transparent"}>
                              <strong>{c.code}</strong> - {c.name}
                            </div>
                          ))
                        ) : (
                          <div style={{ padding: "0.75rem", color: "#94a3b8", fontSize: "0.9rem", fontStyle: "italic", textAlign: "center" }}>No matching accounts found.</div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <button type="button" onClick={addCoa} className="secondary-btn" style={{ marginTop: "1rem", width: "100%" }}>+ Add New Account Code</button>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "2rem" }}>
              <button type="button" onClick={() => setIsCoaModalOpen(false)} className="success-btn">Done</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}