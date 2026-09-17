import React, { useState, useEffect } from "react";
import { UserProfile } from "./AuthModal";

interface UserItem extends UserProfile {
  status: "ACTIVE" | "DISABLED";
  project_roles: Array<{ project_id: string; role: string }>;
  overrides: PermissionOverride[];
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
  prefix?: string;
}

interface RoleTemplate {
  id: string;
  name: string;
  description: string | null;
  is_system_role: boolean;
  permission_keys: string[];
}

interface PermissionDefinition {
  key: string;
  description: string;
  module: string;
}

interface PermissionOverride {
  permission_key: string;
  is_granted: boolean;
}

interface AdminPanelModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: UserProfile | null;
  projects: ProjectItem[];
  /** Called after a save that changes the SIGNED-IN admin's own role/permissions, so the
   * caller can re-hydrate currentUser/userPermissions -- nothing here does that itself. */
  onSelfPermissionsChanged?: () => void;
}

export function AdminPanelModal({
  isOpen,
  onClose,
  currentUser,
  projects,
  onSelfPermissionsChanged,
}: AdminPanelModalProps) {
  const [activeTab, setActiveTab] = useState<
    "ROSTER" | "MATRIX" | "TEMPLATES" | "AUDIT"
  >("ROSTER");
  const [users, setUsers] = useState<UserItem[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditItem[]>([]);
  const [roles, setRoles] = useState<RoleTemplate[]>([]);
  const [permissionRegistry, setPermissionRegistry] = useState<PermissionDefinition[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isSavingPrivileges, setIsSavingPrivileges] = useState<boolean>(false);
  const [isSavingOverrides, setIsSavingOverrides] = useState<boolean>(false);
  const [isSavingTemplate, setIsSavingTemplate] = useState<boolean>(false);

  // Briefly shows a confirmation banner (auto-clears), same pattern as App.tsx's toast --
  // saves succeed silently otherwise, which reads as "did that even work?".
  const flashSuccess = (msg: string) => {
    setSuccessMessage(msg);
    setTimeout(() => {
      setSuccessMessage((prev) => (prev === msg ? null : prev));
    }, 3000);
  };

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

  // Matrix: per-user permission-override state. `overrideScope` is null for Global,
  // or a project id -- each scope's override set is independent (see role.repository.ts's
  // getUserOverrides/setUserOverrides).
  const [overrideScope, setOverrideScope] = useState<string | null>(null);
  const [overrideMap, setOverrideMap] = useState<Record<string, boolean>>({});
  const [isLoadingOverrides, setIsLoadingOverrides] = useState<boolean>(false);

  // Templates tab state: the role template currently being viewed/edited on the right.
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [templateName, setTemplateName] = useState<string>("");
  const [templateDescription, setTemplateDescription] = useState<string>("");
  const [templateKeys, setTemplateKeys] = useState<Set<string>>(new Set());
  const [isNewTemplate, setIsNewTemplate] = useState<boolean>(false);

  // Shared, dynamically-fetched role option list -- replaces 3 previously-hardcoded
  // <select> option lists (create-user form, Matrix global-role picker, Matrix per-project
  // role picker), which had drifted from each other and were all missing "Automation
  // Service".
  const roleOptions = roles.map((r) => ({
    value: r.name,
    label: r.description ? `${r.name} (${r.description})` : r.name,
  }));

  useEffect(() => {
    if (isOpen) {
      fetchUsers();
      fetchAuditLogs();
      fetchRoles();
      fetchPermissionRegistry();
    }
  }, [isOpen]);

  // Reload the selected user's overrides whenever the selected user or scope changes.
  useEffect(() => {
    if (activeTab === "MATRIX" && selectedUserId) {
      fetchOverrides(selectedUserId, overrideScope);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedUserId, overrideScope, activeTab]);

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

  const fetchRoles = async () => {
    try {
      const res = await fetch("/api/v1/admin/roles", { headers: getAuthHeaders() });
      const data = await res.json();
      if (res.ok) {
        setRoles(data.roles || []);
      }
    } catch {
      // Ignore -- roleOptions just stays empty and selects show no choices
    }
  };

  const fetchPermissionRegistry = async () => {
    try {
      const res = await fetch("/api/v1/admin/permissions", { headers: getAuthHeaders() });
      const data = await res.json();
      if (res.ok) {
        setPermissionRegistry(data.permissions || []);
      }
    } catch {
      // Ignore
    }
  };

  const fetchOverrides = async (userId: string, projectId: string | null) => {
    setIsLoadingOverrides(true);
    try {
      const qs = projectId ? `?project_id=${encodeURIComponent(projectId)}` : "";
      const res = await fetch(`/api/v1/admin/users/${userId}/permission-overrides${qs}`, {
        headers: getAuthHeaders(),
      });
      const data = await res.json();
      if (res.ok) {
        const map: Record<string, boolean> = {};
        (data.overrides || []).forEach((o: PermissionOverride) => {
          map[o.permission_key] = o.is_granted;
        });
        setOverrideMap(map);
      }
    } catch {
      setOverrideMap({});
    } finally {
      setIsLoadingOverrides(false);
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
    setOverrideScope(null); // reset to Global scope when switching users
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
    setSuccessMessage(null);
    setIsSavingPrivileges(true);

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
      if (selectedUserId === currentUser?.id) {
        onSelfPermissionsChanged?.();
      }
      flashSuccess("✓ Privilege delegation saved.");
    } catch (err: any) {
      setErrorMessage(err.message || "Failed to update user privileges");
    } finally {
      setIsSavingPrivileges(false);
    }
  };

  // Toggle a permission key's override for the currently selected user/scope. Clicking
  // adds an override forcing the OPPOSITE of whatever the role currently grants; clicking
  // an already-overridden key removes the override, reverting to the role's own value.
  const toggleOverrideKey = (key: string, roleGrantsIt: boolean) => {
    setOverrideMap((prev) => {
      const next = { ...prev };
      if (key in next) {
        delete next[key];
      } else {
        next[key] = !roleGrantsIt;
      }
      return next;
    });
  };

  const handleSaveOverrides = async () => {
    if (!selectedUserId) return;
    setErrorMessage(null);
    setSuccessMessage(null);
    setIsSavingOverrides(true);

    const overrides: PermissionOverride[] = Object.entries(overrideMap).map(
      ([permission_key, is_granted]) => ({ permission_key, is_granted }),
    );

    try {
      const res = await fetch(`/api/v1/admin/users/${selectedUserId}/permission-overrides`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ project_id: overrideScope, overrides }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to update permission overrides");
      }

      fetchUsers();
      fetchAuditLogs();
      if (selectedUserId === currentUser?.id) {
        onSelfPermissionsChanged?.();
      }
      flashSuccess(
        `✓ Permission overrides saved (${overrideScope ? "this project" : "Global"}).`,
      );
    } catch (err: any) {
      setErrorMessage(err.message || "Failed to update permission overrides");
    } finally {
      setIsSavingOverrides(false);
    }
  };

  // --- Templates tab handlers ---

  const handleSelectRole = (roleId: string) => {
    const role = roles.find((r) => r.id === roleId);
    if (!role) return;
    setSelectedRoleId(roleId);
    setIsNewTemplate(false);
    setTemplateName(role.name);
    setTemplateDescription(role.description || "");
    setTemplateKeys(new Set(role.permission_keys));
  };

  const handleNewTemplate = () => {
    setSelectedRoleId(null);
    setIsNewTemplate(true);
    setTemplateName("");
    setTemplateDescription("");
    setTemplateKeys(new Set());
  };

  const toggleTemplateKey = (key: string) => {
    setTemplateKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleSaveTemplate = async () => {
    setErrorMessage(null);
    setSuccessMessage(null);
    setIsSavingTemplate(true);
    const payload = {
      name: templateName,
      description: templateDescription || null,
      permission_keys: Array.from(templateKeys),
    };
    const wasNewTemplate = isNewTemplate;

    try {
      const res = await fetch(
        isNewTemplate ? "/api/v1/admin/roles" : `/api/v1/admin/roles/${selectedRoleId}`,
        {
          method: isNewTemplate ? "POST" : "PUT",
          headers: { "Content-Type": "application/json", ...getAuthHeaders() },
          body: JSON.stringify(payload),
        },
      );

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to save role template");
      }

      await fetchRoles();
      fetchAuditLogs();
      setIsNewTemplate(false);
      setSelectedRoleId(data.role.id);
      flashSuccess(wasNewTemplate ? "✓ Template created." : "✓ Template saved.");
    } catch (err: any) {
      setErrorMessage(err.message || "Failed to save role template");
    } finally {
      setIsSavingTemplate(false);
    }
  };

  const handleDeleteTemplate = async (roleId: string) => {
    setErrorMessage(null);
    try {
      const res = await fetch(`/api/v1/admin/roles/${roleId}`, {
        method: "DELETE",
        headers: getAuthHeaders(),
      });

      if (res.status === 409) {
        const data = await res.json();
        throw new Error(data.detail || "This role is still assigned to one or more users.");
      }
      if (!res.ok && res.status !== 204) {
        const data = await res.json();
        throw new Error(data.error || "Failed to delete role template");
      }

      if (selectedRoleId === roleId) {
        setSelectedRoleId(null);
        setIsNewTemplate(false);
      }
      fetchRoles();
      fetchAuditLogs();
    } catch (err: any) {
      setErrorMessage(err.message || "Failed to delete role template");
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
              Add users, assign global/project privileges, manage role
              templates, and inspect security audit logs.
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
            onClick={() => setActiveTab("TEMPLATES")}
            style={{
              padding: "10px 16px",
              backgroundColor: "transparent",
              border: "none",
              borderBottom:
                activeTab === "TEMPLATES" ? "2px solid #38bdf8" : "none",
              color: activeTab === "TEMPLATES" ? "#38bdf8" : "#94a3b8",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            🎭 Role Templates ({roles.length})
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

        {successMessage && (
          <div
            style={{
              backgroundColor: "#052e16",
              border: "1px solid #16a34a",
              color: "#86efac",
              padding: "8px 12px",
              borderRadius: "6px",
              fontSize: "12px",
              marginBottom: "12px",
              fontWeight: 600,
            }}
          >
            {successMessage}
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
                    {roleOptions.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
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
                      {roleOptions.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
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
                          {roleOptions.map((o) => (
                            <option key={o.value} value={o.value}>
                              Project {o.value}
                            </option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>

                  <button
                    onClick={handleSavePrivileges}
                    disabled={isSavingPrivileges}
                    style={{
                      padding: "8px 16px",
                      backgroundColor: isSavingPrivileges ? "#166534" : "#16a34a",
                      border: "none",
                      borderRadius: "4px",
                      color: "#fff",
                      fontWeight: 600,
                      fontSize: "12px",
                      cursor: isSavingPrivileges ? "default" : "pointer",
                      opacity: isSavingPrivileges ? 0.8 : 1,
                    }}
                  >
                    {isSavingPrivileges ? "Saving..." : "Save Privilege Delegation"}
                  </button>

                  {/* Individual Permission Overrides -- global or per-project, layered on
                      top of whatever the role above already grants. */}
                  <div
                    style={{
                      borderTop: "1px solid #334155",
                      paddingTop: "12px",
                      marginTop: "20px",
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
                      Individual Permission Overrides
                    </h4>
                    <span
                      style={{
                        fontSize: "11px",
                        color: "#94a3b8",
                        display: "block",
                        marginBottom: "12px",
                      }}
                    >
                      Force-grant or force-revoke specific permissions for this user, on top
                      of whatever their role already gives them. A project-scoped override
                      wins over a Global one for the same key.
                    </span>

                    <div style={{ marginBottom: "10px" }}>
                      <label
                        style={{
                          fontSize: "11px",
                          color: "#94a3b8",
                          display: "block",
                          marginBottom: "2px",
                        }}
                      >
                        Scope
                      </label>
                      <select
                        value={overrideScope ?? ""}
                        onChange={(e) => setOverrideScope(e.target.value || null)}
                        style={{
                          padding: "4px 8px",
                          backgroundColor: "#0f172a",
                          border: "1px solid #475569",
                          borderRadius: "4px",
                          color: "#fff",
                          fontSize: "11px",
                        }}
                      >
                        <option value="">Global (all projects)</option>
                        {projects.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    {isLoadingOverrides ? (
                      <div style={{ color: "#64748b", fontSize: "12px" }}>Loading...</div>
                    ) : (
                      <>
                        {Array.from(new Set(permissionRegistry.map((p) => p.module))).map(
                          (moduleName) => (
                            <div key={moduleName} style={{ marginBottom: "10px" }}>
                              <div
                                style={{
                                  fontSize: "10px",
                                  color: "#64748b",
                                  textTransform: "uppercase",
                                  marginBottom: "4px",
                                }}
                              >
                                {moduleName}
                              </div>
                              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                                {permissionRegistry
                                  .filter((p) => p.module === moduleName)
                                  .map((p) => {
                                    const scopedRoleName = overrideScope
                                      ? selectedProjectRoles[overrideScope] || selectedGlobalRole
                                      : selectedGlobalRole;
                                    const role = roles.find((r) => r.name === scopedRoleName);
                                    const roleGrantsIt = role
                                      ? role.permission_keys.includes(p.key)
                                      : false;
                                    const isOverridden = p.key in overrideMap;
                                    const effectiveGranted = isOverridden
                                      ? overrideMap[p.key]
                                      : roleGrantsIt;

                                    let bg = "transparent";
                                    let border = "#4b5563";
                                    let color = "#9ca3af";
                                    if (isOverridden) {
                                      border = "#f59e0b";
                                      color = "#fbbf24";
                                      bg = "rgba(245, 158, 11, 0.15)";
                                    } else if (roleGrantsIt) {
                                      border = "#22c55e";
                                      color = "#4ade80";
                                      bg = "rgba(34, 197, 94, 0.12)";
                                    }

                                    return (
                                      <button
                                        key={p.key}
                                        onClick={() => toggleOverrideKey(p.key, roleGrantsIt)}
                                        title={
                                          isOverridden
                                            ? `Overridden: forced ${effectiveGranted ? "ON" : "OFF"}. Click to revert to the role default (${roleGrantsIt ? "ON" : "OFF"}).`
                                            : `Role default: ${roleGrantsIt ? "ON" : "OFF"}. Click to force ${roleGrantsIt ? "OFF" : "ON"}.`
                                        }
                                        style={{
                                          padding: "3px 8px",
                                          borderRadius: "4px",
                                          fontSize: "10px",
                                          fontWeight: 700,
                                          border: `1px solid ${border}`,
                                          backgroundColor: bg,
                                          color,
                                          cursor: "pointer",
                                        }}
                                      >
                                        {effectiveGranted ? "✓" : "—"} {p.key}
                                      </button>
                                    );
                                  })}
                              </div>
                            </div>
                          ),
                        )}

                        <button
                          onClick={handleSaveOverrides}
                          disabled={isSavingOverrides}
                          style={{
                            padding: "8px 16px",
                            backgroundColor: isSavingOverrides ? "#92400e" : "#d97706",
                            border: "none",
                            borderRadius: "4px",
                            color: "#fff",
                            fontWeight: 600,
                            fontSize: "12px",
                            cursor: isSavingOverrides ? "default" : "pointer",
                            opacity: isSavingOverrides ? 0.8 : 1,
                            marginTop: "8px",
                          }}
                        >
                          {isSavingOverrides
                            ? "Saving..."
                            : `Save Overrides (${overrideScope ? "This Project" : "Global"})`}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ) : (
                <div style={{ color: "#64748b", fontSize: "13px" }}>
                  Select a user from the roster to edit privileges.
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB: ROLE TEMPLATES -- create/edit/delete named permission bundles. Deleting a
            default (is_system_role) is allowed; only being currently assigned to a user
            blocks it (see DELETE /api/v1/admin/roles/:roleId, 409 ROLE_IN_USE). */}
        {activeTab === "TEMPLATES" && (
          <div
            style={{
              display: "flex",
              gap: "20px",
              flex: 1,
              overflow: "hidden",
            }}
          >
            {/* Role List */}
            <div
              style={{
                width: "240px",
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
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <span>TEMPLATE ROLES</span>
                <button
                  onClick={handleNewTemplate}
                  title="New Template"
                  style={{
                    background: "none",
                    border: "none",
                    color: "#38bdf8",
                    cursor: "pointer",
                    fontSize: "14px",
                  }}
                >
                  ➕
                </button>
              </div>
              {roles.map((r) => (
                <div
                  key={r.id}
                  onClick={() => handleSelectRole(r.id)}
                  style={{
                    padding: "10px 12px",
                    cursor: "pointer",
                    backgroundColor:
                      selectedRoleId === r.id ? "#0284c7" : "transparent",
                    color: selectedRoleId === r.id ? "#fff" : "#cbd5e1",
                    borderBottom: "1px solid #0f172a",
                    fontSize: "12px",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 600 }}>{r.name}</div>
                    <div style={{ fontSize: "10px", opacity: 0.8 }}>
                      {r.is_system_role ? "Default" : "Custom"} ·{" "}
                      {r.permission_keys.length} permissions
                    </div>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteTemplate(r.id);
                    }}
                    title="Delete Template"
                    style={{
                      background: "none",
                      border: "none",
                      color: "#f87171",
                      cursor: "pointer",
                      fontSize: "12px",
                    }}
                  >
                    🗑️
                  </button>
                </div>
              ))}
            </div>

            {/* Template Detail Form */}
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
              {selectedRoleId || isNewTemplate ? (
                <div>
                  <h3
                    style={{
                      fontSize: "15px",
                      fontWeight: 700,
                      margin: "0 0 12px 0",
                      color: "#38bdf8",
                    }}
                  >
                    {isNewTemplate ? "New Role Template" : `Editing: ${templateName}`}
                  </h3>

                  <div style={{ marginBottom: "10px" }}>
                    <label
                      style={{
                        fontSize: "11px",
                        color: "#94a3b8",
                        display: "block",
                        marginBottom: "2px",
                      }}
                    >
                      Name
                    </label>
                    <input
                      type="text"
                      value={templateName}
                      onChange={(e) => setTemplateName(e.target.value)}
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
                      Description
                    </label>
                    <input
                      type="text"
                      value={templateDescription}
                      onChange={(e) => setTemplateDescription(e.target.value)}
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
                      Permissions
                    </h4>

                    {Array.from(new Set(permissionRegistry.map((p) => p.module))).map(
                      (moduleName) => (
                        <div key={moduleName} style={{ marginBottom: "10px" }}>
                          <div
                            style={{
                              fontSize: "10px",
                              color: "#64748b",
                              textTransform: "uppercase",
                              marginBottom: "4px",
                            }}
                          >
                            {moduleName}
                          </div>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                            {permissionRegistry
                              .filter((p) => p.module === moduleName)
                              .map((p) => {
                                const isOn = templateKeys.has(p.key);
                                return (
                                  <button
                                    key={p.key}
                                    onClick={() => toggleTemplateKey(p.key)}
                                    title={p.description}
                                    style={{
                                      padding: "3px 8px",
                                      borderRadius: "4px",
                                      fontSize: "10px",
                                      fontWeight: 700,
                                      border: isOn ? "1px solid #22c55e" : "1px solid #4b5563",
                                      backgroundColor: isOn
                                        ? "rgba(34, 197, 94, 0.15)"
                                        : "transparent",
                                      color: isOn ? "#4ade80" : "#9ca3af",
                                      cursor: "pointer",
                                    }}
                                  >
                                    {isOn ? "✓" : "—"} {p.key}
                                  </button>
                                );
                              })}
                          </div>
                        </div>
                      ),
                    )}
                  </div>

                  <button
                    onClick={handleSaveTemplate}
                    disabled={isSavingTemplate}
                    style={{
                      padding: "8px 16px",
                      backgroundColor: isSavingTemplate ? "#166534" : "#16a34a",
                      border: "none",
                      borderRadius: "4px",
                      color: "#fff",
                      fontWeight: 600,
                      fontSize: "12px",
                      cursor: isSavingTemplate ? "default" : "pointer",
                      opacity: isSavingTemplate ? 0.8 : 1,
                    }}
                  >
                    {isSavingTemplate
                      ? "Saving..."
                      : isNewTemplate
                        ? "Create Template"
                        : "Save Template"}
                  </button>
                </div>
              ) : (
                <div style={{ color: "#64748b", fontSize: "13px" }}>
                  Select a template from the list, or create a new one.
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
