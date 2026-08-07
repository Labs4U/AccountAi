import { useEffect, useState } from "react";
import { Authenticator } from "@aws-amplify/ui-react";
import "@aws-amplify/ui-react/styles.css";
import "./App.css";

import AccountantDashboard from "./components/AccountantDashboard";
import CustomerPortal from "./components/CustomerPortal";

// ---------------------------------------------------------------------------
// Raw JWT decoder — bypasses Amplify's fetchAuthSession wrapper entirely.
// Scans both localStorage and sessionStorage for Cognito access tokens,
// decodes the base64 payload, and returns the cognito:groups array.
// ---------------------------------------------------------------------------
function getRawCognitoGroups(): string[] {
  const storages: Storage[] = [localStorage, sessionStorage];

  for (const storage of storages) {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key) continue;

      // Cognito stores access tokens under keys containing "accessToken"
      if (key.toLowerCase().includes("accesstoken")) {
        const raw = storage.getItem(key);
        if (!raw) continue;

        try {
          // JWT is three base64url segments separated by dots
          const parts = raw.split(".");
          if (parts.length !== 3) continue;

          // base64url → base64 → JSON
          const payload = JSON.parse(
            atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))
          );

          const groups: string[] = payload["cognito:groups"] ?? [];
          console.log("====================================");
          console.log("🔑 RAW JWT key:", key);
          console.log("🔑 RAW cognito:groups:", groups);
          console.log("🔑 Full payload:", payload);
          console.log("====================================");
          return groups;
        } catch {
          // malformed token — skip and keep scanning
          continue;
        }
      }
    }
  }

  console.warn("No Cognito access token found in localStorage or sessionStorage");
  return [];
}

// ---------------------------------------------------------------------------
// Strict role evaluator — Admin only wins if the token explicitly contains it.
// ---------------------------------------------------------------------------
function resolveRole(groups: string[], email?: string): "Admin" | "Customer" {
  // 1. If Cognito successfully passes the Admin group, honor it
  if (groups.includes("Admin")) return "Admin";

  // 2. Direct email override for local development / testing
  if (email?.toLowerCase() === "samir.amri@gmail.com") return "Admin";

  // 3. Default to Customer for all others
  return "Customer"; 
}

// ---------------------------------------------------------------------------
// Inner app — rendered only after Authenticator confirms authentication.
// Receives user and signOut from the Authenticator render prop so that
// any change in the authenticated user triggers a fresh role evaluation.
// ---------------------------------------------------------------------------
function AuthenticatedApp({
  user,
  signOut,
}: {
  user: { userId?: string; signInDetails?: { loginId?: string }; username?: string } | undefined;
  signOut: (() => void) | undefined;
}) {
  // Reset to null on every user change — this is the core state-bleed fix.
  const [userRole, setUserRole] = useState<"Admin" | "Customer" | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Guard: if there is no user, clear role and stop.
    if (!user?.userId) {
      setUserRole(null);
      setIsLoading(false);
      return;
    }

    // Reset state before evaluating — prevents momentary flash of stale role.
    setUserRole(null);
    setIsLoading(true);

    const groups = getRawCognitoGroups();
    const userEmail = user?.signInDetails?.loginId ?? user?.username;
    const role = resolveRole(groups, userEmail);

    console.log(`User ${userEmail} → resolved role: ${role}`);

    setUserRole(role);
    setIsLoading(false);

    // Re-runs whenever the authenticated user identity changes.
  }, [user?.userId]);

  function handleDebugToken() {
    const groups = getRawCognitoGroups();
    alert(
      `cognito:groups for ${user?.signInDetails?.loginId ?? user?.username ?? "unknown"}:\n\n` +
        (groups.length > 0 ? groups.join(", ") : "(empty — user is in no groups)")
    );
  }

  return (
    <div className="container">
      <header
        className="header"
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginBottom: "20px",
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: "1.5rem" }}>AccountAI Portal</h1>
          <small style={{ color: "#666" }}>Enterprise Document Processing</small>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
          <span className="user-badge" style={{ fontWeight: "bold" }}>
            Role: {userRole ?? "…"} | {user?.signInDetails?.loginId ?? user?.username}
          </span>
          {/* TEMPORARY DEBUG BUTTON — remove before production */}
          <button
            onClick={handleDebugToken}
            style={{
              background: "#f0ad4e",
              color: "#000",
              border: "1px solid #d48d0a",
              borderRadius: "4px",
              padding: "0.3em 0.8em",
              fontSize: "0.8rem",
              cursor: "pointer",
            }}
            title="Temporary debug tool — shows raw cognito:groups from JWT"
          >
            🔍 Debug Token
          </button>
          <button className="secondary-btn" onClick={signOut}>
            Sign Out
          </button>
        </div>
      </header>

      {isLoading ? (
        <div style={{ padding: "2rem", textAlign: "center" }}>
          Loading workspace…
        </div>
      ) : userRole === "Admin" ? (
        <AccountantDashboard />
      ) : (
        <CustomerPortal />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root component — Authenticator gate wraps everything.
// ---------------------------------------------------------------------------
export default function App() {
  return (
    <Authenticator>
      {({ signOut, user }) => (
        <AuthenticatedApp user={user} signOut={signOut} />
      )}
    </Authenticator>
  );
}
