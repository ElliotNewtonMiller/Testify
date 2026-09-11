import React, { useState } from "react";
import { validatePasswordPolicy } from "../../../../packages/core/src/security/passwordPolicy";

export interface UserProfile {
  id: string;
  username: string;
  email: string;
  global_role: string;
  permissions: string[];
}

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: UserProfile | null;
  onLoginSuccess: (user: UserProfile, token: string) => void;
  onUpdateCredentialsSuccess: (updatedUser: UserProfile) => void;
}

export function AuthModal({
  isOpen,
  onClose,
  currentUser,
  onLoginSuccess,
  onUpdateCredentialsSuccess,
}: AuthModalProps) {
  const [identifier, setIdentifier] = useState<string>("admin");
  const [password, setPassword] = useState<string>("password");

  const [newUsername, setNewUsername] = useState<string>(
    currentUser?.username || "",
  );
  const [newPassword, setNewPassword] = useState<string>("");
  const [newEmail, setNewEmail] = useState<string>(currentUser?.email || "");

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);

  if (!isOpen) return null;

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);
    setIsLoading(true);

    try {
      const res = await fetch("/api/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: identifier, password }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Invalid credentials");
      }

      onLoginSuccess(data.user, data.token);
      onClose();
    } catch (err: any) {
      setErrorMessage(err.message || "Login failed");
    } finally {
      setIsLoading(false);
    }
  };

  const handleUpdateCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);

    if (newPassword) {
      const validation = validatePasswordPolicy(newPassword);
      if (!validation.valid) {
        setErrorMessage(`Password Policy Violation: ${validation.reason}`);
        return;
      }
    }

    setIsLoading(true);

    try {
      const res = await fetch("/api/v1/auth/credentials", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-User-Id": currentUser?.id || "",
        },
        body: JSON.stringify({
          newUsername:
            newUsername !== currentUser?.username ? newUsername : undefined,
          newEmail: newEmail !== currentUser?.email ? newEmail : undefined,
          newPassword: newPassword || undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to update credentials");
      }

      setSuccessMessage("Credentials updated successfully!");
      onUpdateCredentialsSuccess(data.user);
      setNewPassword("");
    } catch (err: any) {
      setErrorMessage(err.message || "Failed to update credentials");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(0, 0, 0, 0.75)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        style={{
          width: "420px",
          backgroundColor: "#0f172a",
          border: "1px solid #1e293b",
          borderRadius: "8px",
          padding: "24px",
          color: "#f8fafc",
          boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.5)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "16px",
          }}
        >
          <h2
            style={{
              fontSize: "18px",
              fontWeight: 700,
              margin: 0,
              color: "#38bdf8",
            }}
          >
            {currentUser
              ? "User Profile & Credentials"
              : "Authentication Login"}
          </h2>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: "#94a3b8",
              fontSize: "18px",
              cursor: "pointer",
            }}
          >
            ✕
          </button>
        </div>

        {errorMessage && (
          <div
            style={{
              backgroundColor: "#450a0a",
              border: "1px solid #991b1b",
              color: "#fca5a5",
              padding: "10px 12px",
              borderRadius: "6px",
              fontSize: "12px",
              marginBottom: "16px",
            }}
          >
            ⚠️ {errorMessage}
          </div>
        )}

        {successMessage && (
          <div
            style={{
              backgroundColor: "#064e3b",
              border: "1px solid #047857",
              color: "#6ee7b7",
              padding: "10px 12px",
              borderRadius: "6px",
              fontSize: "12px",
              marginBottom: "16px",
            }}
          >
            ✓ {successMessage}
          </div>
        )}

        {/* LOGIN FORM (WHEN SIGNED OUT) */}
        {!currentUser && (
          <form onSubmit={handleLogin}>
            <div style={{ marginBottom: "14px" }}>
              <label
                style={{
                  display: "block",
                  fontSize: "12px",
                  color: "#cbd5e1",
                  marginBottom: "4px",
                }}
              >
                Username or Email
              </label>
              <input
                type="text"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder="admin"
                required
                style={{
                  width: "100%",
                  padding: "8px 12px",
                  backgroundColor: "#1e293b",
                  border: "1px solid #475569",
                  borderRadius: "4px",
                  color: "#f8fafc",
                  fontSize: "13px",
                }}
              />
            </div>

            <div style={{ marginBottom: "20px" }}>
              <label
                style={{
                  display: "block",
                  fontSize: "12px",
                  color: "#cbd5e1",
                  marginBottom: "4px",
                }}
              >
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                style={{
                  width: "100%",
                  padding: "8px 12px",
                  backgroundColor: "#1e293b",
                  border: "1px solid #475569",
                  borderRadius: "4px",
                  color: "#f8fafc",
                  fontSize: "13px",
                }}
              />
            </div>

            <button
              type="submit"
              disabled={isLoading}
              style={{
                width: "100%",
                padding: "10px",
                backgroundColor: "#0284c7",
                border: "none",
                borderRadius: "6px",
                color: "#ffffff",
                fontWeight: 600,
                fontSize: "13px",
                cursor: isLoading ? "not-allowed" : "pointer",
              }}
            >
              {isLoading ? "Signing In..." : "Sign In to Workspace"}
            </button>
          </form>
        )}

        {/* PROFILE CREDENTIAL UPDATE FORM */}
        {currentUser && (
          <form onSubmit={handleUpdateCredentials}>
            {(() => {
              const isAdmin =
                currentUser?.global_role === "Admin" ||
                currentUser?.permissions?.includes("USER_MANAGE") ||
                currentUser?.permissions?.includes("SYSTEM_ADMIN");
              if (!isAdmin) return null;
              return (
                <div style={{ marginBottom: "12px" }}>
                  <label
                    style={{
                      display: "block",
                      fontSize: "12px",
                      color: "#cbd5e1",
                      marginBottom: "4px",
                    }}
                  >
                    Update Username
                  </label>
                  <input
                    type="text"
                    value={newUsername}
                    onChange={(e) => setNewUsername(e.target.value)}
                    style={{
                      width: "100%",
                      boxSizing: "border-box",
                      padding: "8px 12px",
                      backgroundColor: "#1e293b",
                      border: "1px solid #475569",
                      borderRadius: "4px",
                      color: "#f8fafc",
                      fontSize: "13px",
                    }}
                  />
                </div>
              );
            })()}

            <div style={{ marginBottom: "12px" }}>
              <label
                style={{
                  display: "block",
                  fontSize: "12px",
                  color: "#cbd5e1",
                  marginBottom: "4px",
                }}
              >
                Update Email
              </label>
              <input
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                style={{
                  width: "100%",
                  padding: "8px 12px",
                  backgroundColor: "#1e293b",
                  border: "1px solid #475569",
                  borderRadius: "4px",
                  color: "#f8fafc",
                  fontSize: "13px",
                }}
              />
            </div>

            <div style={{ marginBottom: "20px" }}>
              <label
                style={{
                  display: "block",
                  fontSize: "12px",
                  color: "#cbd5e1",
                  marginBottom: "4px",
                }}
              >
                New Password (leave blank to keep current)
              </label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Enter new password..."
                style={{
                  width: "100%",
                  padding: "8px 12px",
                  backgroundColor: "#1e293b",
                  border: "1px solid #475569",
                  borderRadius: "4px",
                  color: "#f8fafc",
                  fontSize: "13px",
                }}
              />
              <div
                style={{
                  fontSize: "11px",
                  color: "#94a3b8",
                  marginTop: "6px",
                  lineHeight: "1.4",
                  backgroundColor: "#1e293b",
                  padding: "8px",
                  borderRadius: "4px",
                }}
              >
                🔒 <strong>Password Policy Rules:</strong>
                <ul style={{ margin: "4px 0 0 16px", padding: 0 }}>
                  <li>
                    8 - 15 chars: Needs 1 digit, 1 uppercase letter, and 1
                    symbol.
                  </li>
                  <li>
                    16 - 100 chars: No special character type restrictions.
                  </li>
                </ul>
              </div>
            </div>

            <button
              type="submit"
              disabled={isLoading}
              style={{
                width: "100%",
                padding: "10px",
                backgroundColor: "#16a34a",
                border: "none",
                borderRadius: "6px",
                color: "#ffffff",
                fontWeight: 600,
                fontSize: "13px",
                cursor: isLoading ? "not-allowed" : "pointer",
              }}
            >
              {isLoading ? "Updating..." : "Save New Credentials"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
