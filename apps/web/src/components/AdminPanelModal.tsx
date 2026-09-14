import React, { useState, useEffect } from "react";
import { UserProfile } from "./AuthModal";

interface UserItem extends UserProfile {
  status: "ACTIVE" | "DISABLED";
  project_roles: Array<{ project_id: string; role: string }>;
  created_at: string;
}

interface AuditItem {
  id: string;
  actor_id: string;
  action: string;
  resource_type: string;
  resource_id: string;
  diff: string;
  created_at: string;
}

interface ProjectItem {
  id: string;
  name: string;
  prefix: string;
}

interface AdminPanelModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: UserProfile | null;
  projects: ProjectItem[];
}

export function AdminPanelModal({
  isOpen,
  onClose,
  currentUser,
  projects,
}: AdminPanelModalProps) {
  const [activeTab, setActiveTab] = useState<"ROSTER" | "MATRIX" | "AUDIT">(
    "ROSTER",
  );
  const [users, setUsers] = useState<UserItem[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditItem[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // New user form state
  const [newUsername, setNewUsername] = useState<string>("");
  const [newEmail, setNewEmail] = useState<string>("");
  const [newPassword, setNewPassword] = useState<string>("");
  const [newRole, setNewRole] = useState<string>("Tester");

  // Matrix selection state
  const [selectedUserId, setSelectedUserId] = useState<string>("");
  const [selectedGlobalRole, setSelectedGlobalRole] =
    useState<string>("Tester");
  const [selectedProjectRoles, setSelectedProjectRoles] = useState<
    Record<string, string>
  >({});

  useEffect(() => {
    if (isOpen) {
      fetchUsers();
      fetchAuditLogs();
    }
  }, [isOpen]);

  // Builds the Authorization header from the signed JWT in localStorage. The admin API
  // requires a real Bearer token on every request (see apps/server/src/middleware/auth.ts) --
  // there is no X-User-Id impersonation header anymore, so callers must always use this.
  const getAuthHeaders = (): Record<string, string> => {
    const token = localStorage.getItem("auth_token");
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

  const fetchUsers = async () => {
    setIsLoading(true);
    try {
      const res = await fetch("/api/v1/admin/users", {
        headers: getAuthHeaders(),
      });
      const data = await res.json();
      if (res.ok) {
        setUsers(data.users || []);
        if (data.users && data.users.length > 0 && !selectedUserId) {
          const first = data.users[0];
          setSelectedUserId(first.id);
          setSelectedGlobalRole(first.global_role);
          const pMap: Record<string, string> = {};
          (first.project_roles || []).forEach((pr: any) => {
            pMap[pr.project_id] = pr.role;
          });
          setSelectedProjectRoles(pMap);
        }
      }
    } catch (err: any) {
      setErrorMessage(err.message || "Failed to fetch user roster");
    } finally {
      setIsLoading(false);
    }
  };

  const fetchAuditLogs = async () => {
    try {
      const res = await fetch("/api/v1/admin/audit-logs", {
        headers: getAuthHeaders(),
      });
      const data = await res.json();
      if (res.ok) {
        setAuditLogs(data.audit_logs || []);
      }
    } catch {
      // Ignore audit log error
    }
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    try {
      const res = await fetch("/api/v1/admin/users", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...getAuthHeaders(),
        },
        body: JSON.stringify({
          username: newUsername,
          email: newEmail,
          password: newPassword,
          global_role: newRole,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to create user");
      }

      setNewUsername("");
      setNewEmail("");
      setNewPassword("");
      fetchUsers();
      fetchAuditLogs();
    } catch (err: any) {
      setErrorMessage(err.message || "Failed to create user");
    }
  };

  const handleToggleStatus = async (userId: string, currentStatus: string) => {
    const nextStatus = currentStatus === "ACTIVE" ? "DISABLED" : "ACTIVE";
    try {
      const res = await fetch(`/api/v1/admin/users/${userId}/status`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...getAuthHeaders(),
        },
        body: JSON.stringify({ status: nextStatus }),
      });
      if (res.ok) {
        fetchUsers();
        fetchAuditLogs();
      }
    } catch {
      // Handle status toggle error
    }
  };

  const handleUserSelectInMatrix = (uId: string) => {
    setSelectedUserId(uId);
    const target = users.find((u) => u.id === uId);
    if (target) {
      setSelectedGlobalRole(target.global_role);
      const pMap: Record<string, string> = {};
      (target.project_roles || []).forEach((pr: any) => {
        pMap[pr.project_id] = pr.role;
      });
      setSelectedProjectRoles(pMap);
    }
  };

  const handleSavePrivileges = async () => {
    if (!selectedUserId) return;
    setErrorMessage(null);

    const project_roles = Object.entries(selectedProjectRoles).map(
      ([pId, r]) => ({
        project_id: pId,
        role: r,
      }),
    );

    try {
      const res = await fetch(`/api/v1/admin/users/${selectedUserId}/roles`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...getAuthHeaders(),
        },
        body: JSON.stringify({
          global_role: selectedGlobalRole,
          project_roles,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to update user privileges");
      }

      fetchUsers();
      fetchAuditLogs();
    } catch (err: any) {
      setErrorMessage(err.message || "Failed to update user privileges");
    }
  };

  if (!isOpen) return null;

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(0, 0, 0, 0.8)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        style={{
          width: "840px",
          maxHeight: "85vh",
          backgroundColor: "#0f172a",
          border: "1px solid #1e293b",
          borderRadius: "10px",
          padding: "24px",
          color: "#f8fafc",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.7)",
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
          <div>
            <h2
              style={{
                fontSize: "20px",
                fontWeight: 700,
                margin: 0,
                color: "#38bdf8",
              }}
            >
              RBAC & User Administration Panel
            </h2>
            <span style={{ fontSize: "12px", color: "#94a3b8" }}>
              Add users, assign global/project privileges, and inspect
              security audit logs.
            </span>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: "#94a3b8",
              fontSize: "20px",
              cursor: "pointer",
            }}
          >
            ✕
          </button>
        </div>

        {/* Tab Headers */}
        <div
          style={{
            display: "flex",
            borderBottom: "1px solid #334155",
            marginBottom: "16px",
          }}
        >
          <button
            onClick={() => setActiveTab("ROSTER")}
            style={{
              padding: "10px 16px",
              backgroundColor: "transparent",
              border: "none",
              borderBottom:
                activeTab === "ROSTER" ? "2px solid #38bdf8" : "none",
              color: activeTab === "ROSTER" ? "#38bdf8" : "#94a3b8",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            👥 User Roster ({users.length})
          </button>
          <button
            onClick={() => setActiveTab("MATRIX")}
            style={{
              padding: "10px 16px",
              backgroundColor: "transparent",
              border: "none",
              borderBottom:
                activeTab === "MATRIX" ? "2px solid #38bdf8" : "none",
              color: activeTab === "MATRIX" ? "#38bdf8" : "#94a3b8",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            🔑 Privilege & Access Matrix
          </button>
          <button
            onClick={() => setActiveTab("AUDIT")}
            style={{
              padding: "10px 16px",
              backgroundColor: "transparent",
              border: "none",
              borderBottom:
                activeTab === "AUDIT" ? "2px solid #38bdf8" : "none",
              color: activeTab === "AUDIT" ? "#38bdf8" : "#94a3b8",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            📋 Security Audit Log
          </button>
        </div>

        {errorMessage && (
          <div
            style={{
              backgroundColor: "#450a0a",
              border: "1px solid #991b1b",
              color: "#fca5a5",
              padding: "8px 12px",
              borderRadius: "6px",
              fontSize: "12px",
              marginBottom: "12px",
            }}
          >
            ⚠️ {errorMessage}
          </div>
        )}

        {/* TAB 1: USER ROSTER & ADD USER */}
        {activeTab === "ROSTER" && (
          <div
            style={{
              display: "flex",
              gap: "20px",
              flex: 1,
              overflow: "hidden",
            }}
          >
            {/* Create User Form */}
            <div
              style={{
                width: "280px",
                boxSizing: "border-box",
                backgroundColor: "#1e293b",
                padding: "16px",
                borderRadius: "6px",
                border: "1px solid #334155",
              }}
            >
              <h3
                style={{
                  fontSize: "14px",
                  fontWeight: 700,
                  margin: "0 0 12px 0",
                  color: "#e2e8f0",
                }}
              >
                Add New User
              </h3>
              <form onSubmit={handleCreateUser}>
                <div style={{ marginBottom: "10px" }}>
                  <label
                    style={{
                      fontSize: "11px",
                      color: "#94a3b8",
                      display: "block",
                      marginBottom: "2px",
                    }}
                  >
                    Username
                  </label>
                  <input
                    type="text"
                    value={newUsername}
                    onChange={(e) => setNewUsername(e.target.value)}
                    required
                    style={{
                      width: "100%",
                      boxSizing: "border-box",
                      padding: "6px 8px",
                      backgroundColor: "#0f172a",
                      border: "1px solid #475569",
                      borderRadius: "4px",
                      color: "#fff",
                      fontSize: "12px",
                    }}
                  />
                </div>
                <div style={{ marginBottom: "10px" }}>
                  <label
                    style={{
                      fontSize: "11px",
                      color: "#94a3b8",
                      display: "block",
                      marginBottom: "2px",
                    }}
                  >
                    Email
                  </label>
                  <input
                    type="email"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    required
                    style={{
                      width: "100%",
                      boxSizing: "border-box",
                      padding: "6px 8px",
                      backgroundColor: "#0f172a",
                      border: "1px solid #475569",
                      borderRadius: "4px",
                      color: "#fff",
                      fontSize: "12px",
                    }}
                  />
                </div>
                <div style={{ marginBottom: "10px" }}>
                  <label
                    style={{
                      fontSize: "11px",
                      color: "#94a3b8",
                      display: "block",
                      marginBottom: "2px",
                    }}
                  >
                    Initial Password
                  </label>
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    required
                    style={{
                      width: "100%",
                      boxSizing: "border-box",
                      padding: "6px 8px",
                      backgroundColor: "#0f172a",
                      border: "1px solid #475569",
                      borderRadius: "4px",
                      color: "#fff",
                      fontSize: "12px",
                    }}
                  />
                </div>
                <div style={{ marginBottom: "14px" }}>
                  <label
                    style={{
                      fontSize: "11px",
                      color: "#94a3b8",
                      display: "block",
                      marginBottom: "2px",
                    }}
                  >
                    Global Role
                  </label>
                  <select
                    value={newRole}
                    onChange={(e) => setNewRole(e.target.value)}
                    style={{
                      width: "100%",
                      boxSizing: "border-box",
                      padding: "6px 8px",
                      backgroundColor: "#0f172a",
                      border: "1px solid #475569",
                      borderRadius: "4px",
                      color: "#fff",
                      fontSize: "12px",
                    }}
                  >
                    <option value="Admin">Admin (Full Control)</option>
                    <option value="Test Lead">
                      Test Lead (Approve & Manage)
                    </option>
                    <option value="Tester">Tester (Execute & Draft)</option>
                    <option value="Viewer">Viewer (Read-Only)</option>
                  </select>
                </div>
                <button
                  type="submit"
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    padding: "8px",
                    backgroundColor: "#0284c7",
                    border: "none",
                    borderRadius: "4px",
                    color: "#fff",
                    fontWeight: 600,
                    fontSize: "12px",
                    cursor: "pointer",
                  }}
                >
                  Add User
                </button>
              </form>
            </div>

            {/* Roster Table */}
            <div
              style={{
                flex: 1,
                overflowY: "auto",
                backgroundColor: "#1e293b",
                borderRadius: "6px",
                border: "1px solid #334155",
                padding: "12px",
              }}
            >
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: "12px",
                  color: "#e2e8f0",
                }}
              >
                <thead>
                  <tr
                    style={{
                      borderBottom: "1px solid #334155",
                      textAlign: "left",
                      color: "#94a3b8",
                    }}
                  >
                    <th style={{ padding: "8px" }}>User</th>
                    <th style={{ padding: "8px" }}>Global Role</th>
                    <th style={{ padding: "8px" }}>Status</th>
                    <th style={{ padding: "8px", textAlign: "right" }}>
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr
                      key={u.id}
                      style={{ borderBottom: "1px solid #0f172a" }}
                    >
                      <td style={{ padding: "8px" }}>
                        <strong>{u.username}</strong>
                        <div style={{ fontSize: "10px", color: "#64748b" }}>
                          {u.email}
                        </div>
                      </td>
                      <td style={{ padding: "8px" }}>
                        <span
                          style={{
                            backgroundColor:
                              u.global_role === "Admin" ? "#7c3aed" : "#0284c7",
                            padding: "2px 6px",
                            borderRadius: "4px",
                            fontSize: "10px",
                            fontWeight: 700,
                          }}
                        >
                          {u.global_role}
                        </span>
                      </td>
                      <td style={{ padding: "8px" }}>
                        <span
                          style={{
                            color:
                              u.status === "ACTIVE" ? "#4ade80" : "#f87171",
                            fontWeight: 600,
                          }}
                        >
                          {u.status}
                        </span>
                      </td>
                      <td style={{ padding: "8px", textAlign: "right" }}>
                        <button
                          onClick={() => handleToggleStatus(u.id, u.status)}
                          style={{
                            backgroundColor:
                              u.status === "ACTIVE" ? "#991b1b" : "#166534",
                            border: "none",
                            color: "#fff",
                            padding: "4px 8px",
                            borderRadius: "4px",
                            fontSize: "11px",
                            cursor: "pointer",
                          }}
                        >
                          {u.status === "ACTIVE" ? "Disable" : "Activate"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* TAB 2: PRIVILEGE & ACCESS MATRIX */}
        {activeTab === "MATRIX" && (
          <div
            style={{
              display: "flex",
              gap: "20px",
              flex: 1,
              overflow: "hidden",
            }}
          >
            {/* User Selector List */}
            <div
              style={{
                width: "220px",
                backgroundColor: "#1e293b",
                borderRadius: "6px",
                border: "1px solid #334155",
                overflowY: "auto",
              }}
            >
              <div
                style={{
                  padding: "10px",
                  fontSize: "11px",
                  color: "#94a3b8",
                  borderBottom: "1px solid #334155",
                  fontWeight: 700,
                }}
              >
                SELECT USER TO EDIT PRIVILEGES
              </div>
              {users.map((u) => (
                <div
                  key={u.id}
                  onClick={() => handleUserSelectInMatrix(u.id)}
                  style={{
                    padding: "10px 12px",
                    cursor: "pointer",
                    backgroundColor:
                      selectedUserId === u.id ? "#0284c7" : "transparent",
                    color: selectedUserId === u.id ? "#fff" : "#cbd5e1",
                    borderBottom: "1px solid #0f172a",
                    fontSize: "12px",
                  }}
                >
                  <div style={{ fontWeight: 600 }}>{u.username}</div>
                  <div style={{ fontSize: "10px", opacity: 0.8 }}>
                    {u.global_role}
                  </div>
                </div>
              ))}
            </div>

            {/* Matrix Form */}
            <div
              style={{
                flex: 1,
                backgroundColor: "#1e293b",
                padding: "16px",
                borderRadius: "6px",
                border: "1px solid #334155",
                overflowY: "auto",
              }}
            >
              {selectedUserId ? (
                <div>
                  <h3
                    style={{
                      fontSize: "15px",
                      fontWeight: 700,
                      margin: "0 0 12px 0",
                      color: "#38bdf8",
                    }}
                  >
                    Privilege Delegation for{" "}
                    {users.find((u) => u.id === selectedUserId)?.username}
                  </h3>

                  <div style={{ marginBottom: "16px" }}>
                    <label
                      style={{
                        fontSize: "12px",
                        color: "#cbd5e1",
                        display: "block",
                        marginBottom: "4px",
                        fontWeight: 600,
                      }}
                    >
                      Global System Role
                    </label>
                    <select
                      value={selectedGlobalRole}
                      onChange={(e) => setSelectedGlobalRole(e.target.value)}
                      style={{
                        padding: "6px 12px",
                        backgroundColor: "#0f172a",
                        border: "1px solid #475569",
                        borderRadius: "4px",
                        color: "#fff",
                        fontSize: "12px",
                      }}
                    >
                      <option value="Admin">
                        Admin (SYSTEM_ADMIN & USER_MANAGE)
                      </option>
                      <option value="Test Lead">
                        Test Lead (Approve Specs & USER_MANAGE)
                      </option>
                      <option value="Tester">Tester (Execute & Draft)</option>
                      <option value="Viewer">Viewer (Read-Only)</option>
                    </select>
                  </div>

                  <div
                    style={{
                      borderTop: "1px solid #334155",
                      paddingTop: "12px",
                      marginBottom: "16px",
                    }}
                  >
                    <h4
                      style={{
                        fontSize: "13px",
                        fontWeight: 700,
                        margin: "0 0 8px 0",
                        color: "#e2e8f0",
                      }}
                    >
                      Explicit Per-Project Role Overrides
                    </h4>
                    <span
                      style={{
                        fontSize: "11px",
                        color: "#94a3b8",
                        display: "block",
                        marginBottom: "12px",
                      }}
                    >
                      Project access is explicit per user. Select custom role
                      overrides per project workspace.
                    </span>

                    {projects.map((p) => (
                      <div
                        key={p.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          padding: "8px 0",
                          borderBottom: "1px solid #0f172a",
                        }}
                      >
                        <div>
                          <strong
                            style={{ fontSize: "12px", color: "#f8fafc" }}
                          >
                            {p.name}
                          </strong>
                          <span
                            style={{
                              fontSize: "10px",
                              color: "#64748b",
                              marginLeft: "6px",
                            }}
                          >
                            ({p.prefix})
                          </span>
                        </div>
                        <select
                          value={selectedProjectRoles[p.id] || ""}
                          onChange={(e) => {
                            const val = e.target.value;
                            setSelectedProjectRoles((prev) => {
                              const next = { ...prev };
                              if (val) next[p.id] = val;
                              else delete next[p.id];
                              return next;
                            });
                          }}
                          style={{
                            padding: "4px 8px",
                            backgroundColor: "#0f172a",
                            border: "1px solid #475569",
                            borderRadius: "4px",
                            color: "#fff",
                            fontSize: "11px",
                          }}
                        >
                          <option value="">(No Explicit Access)</option>
                          <option value="Admin">Project Admin</option>
                          <option value="Test Lead">Project Test Lead</option>
                          <option value="Tester">Project Tester</option>
                          <option value="Viewer">Project Viewer</option>
                        </select>
                      </div>
                    ))}
                  </div>

                  <button
                    onClick={handleSavePrivileges}
                    style={{
                      padding: "8px 16px",
                      backgroundColor: "#16a34a",
                      border: "none",
                      borderRadius: "4px",
                      color: "#fff",
                      fontWeight: 600,
                      fontSize: "12px",
                      cursor: "pointer",
                    }}
                  >
                    Save Privilege Delegation
                  </button>
                </div>
              ) : (
                <div style={{ color: "#64748b", fontSize: "13px" }}>
                  Select a user from the roster to edit privileges.
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 3: FILTERED SECURITY AUDIT LOG */}
        {activeTab === "AUDIT" && (
          <div
            style={{
              flex: 1,
              backgroundColor: "#1e293b",
              borderRadius: "6px",
              border: "1px solid #334155",
              padding: "12px",
              overflowY: "auto",
            }}
          >
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "11px",
                color: "#e2e8f0",
              }}
            >
              <thead>
                <tr
                  style={{
                    borderBottom: "1px solid #334155",
                    textAlign: "left",
                    color: "#94a3b8",
                  }}
                >
                  <th style={{ padding: "6px" }}>Timestamp</th>
                  <th style={{ padding: "6px" }}>Security Action</th>
                  <th style={{ padding: "6px" }}>Resource ID</th>
                  <th style={{ padding: "6px" }}>Diff Payload</th>
                </tr>
              </thead>
              <tbody>
                {auditLogs.map((log) => (
                  <tr
                    key={log.id}
                    style={{ borderBottom: "1px solid #0f172a" }}
                  >
                    <td
                      style={{
                        padding: "6px",
                        color: "#64748b",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {new Date(log.created_at).toLocaleString()}
                    </td>
                    <td style={{ padding: "6px" }}>
                      <span
                        style={{
                          backgroundColor: "#0f172a",
                          padding: "2px 6px",
                          borderRadius: "4px",
                          color: "#38bdf8",
                          fontWeight: 700,
                        }}
                      >
                        {log.action}
                      </span>
                    </td>
                    <td
                      style={{
                        padding: "6px",
                        fontFamily: "monospace",
                        color: "#cbd5e1",
                      }}
                    >
                      {log.resource_id.substring(0, 8)}...
                    </td>
                    <td
                      style={{
                        padding: "6px",
                        fontFamily: "monospace",
                        color: "#94a3b8",
                        fontSize: "10px",
                      }}
                    >
                      {log.diff}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
