import React, { useState, useEffect, useLayoutEffect, useRef } from "react";
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

type CustomFieldType = "TEXT" | "NUMBER" | "CHECKBOX" | "DATE" | "SINGLE_SELECT" | "MULTI_SELECT";
type CustomFieldEntityType = "TestCase" | "TestSuite";

const CUSTOM_FIELD_TYPE_OPTIONS: Array<{ value: CustomFieldType; label: string }> = [
  { value: "TEXT", label: "Text" },
  { value: "NUMBER", label: "Number" },
  { value: "CHECKBOX", label: "Checkbox" },
  { value: "DATE", label: "Date" },
  { value: "SINGLE_SELECT", label: "Single-select" },
  { value: "MULTI_SELECT", label: "Multi-select" },
];

interface CustomFieldOption {
  option_label: string;
  option_value: string;
}

interface CustomFieldDefinition {
  id: string;
  entity_type: CustomFieldEntityType;
  name: string;
  field_label: string;
  field_type: CustomFieldType;
  is_required: boolean;
  default_value: string | null;
  validation_regex: string | null;
  options: CustomFieldOption[];
}

interface ApiTokenItem {
  id: string;
  project_id: string;
  name: string;
  token_prefix: string;
  capabilities: string[];
  created_by: string;
  expires_at: string | null;
  is_revoked: boolean;
  last_used_at: string | null;
  created_at: string;
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
    "ROSTER" | "MATRIX" | "TEMPLATES" | "CUSTOM_FIELDS" | "API_TOKENS" | "AUDIT"
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
  const [isSavingField, setIsSavingField] = useState<boolean>(false);

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

  // Custom Fields tab state: the field definition currently being viewed/edited on the
  // right. entity_type and field_type are immutable once created -- changing either would
  // orphan the meaning of any existing values, so they're locked in the form after creation.
  const [customFields, setCustomFields] = useState<CustomFieldDefinition[]>([]);
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const [isNewField, setIsNewField] = useState<boolean>(false);
  const [fieldEntityType, setFieldEntityType] = useState<CustomFieldEntityType>("TestCase");
  const [fieldName, setFieldName] = useState<string>("");
  const [fieldLabel, setFieldLabel] = useState<string>("");
  const [fieldType, setFieldType] = useState<CustomFieldType>("TEXT");
  const [fieldIsRequired, setFieldIsRequired] = useState<boolean>(false);
  const [fieldDefaultValue, setFieldDefaultValue] = useState<string>("");
  const [fieldValidationRegex, setFieldValidationRegex] = useState<string>("");
  const [fieldOptions, setFieldOptions] = useState<CustomFieldOption[]>([]);
  // Per-row refs for the Options list's inputs, keyed by index -- lets addFieldOption()
  // focus the newly-added row once it actually exists in the DOM (the ref doesn't exist
  // yet during addFieldOption() itself), mirroring App.tsx's stepActionRefs/
  // pendingStepFocusIndexRef pattern for the step editor's "+ Add Step".
  const fieldOptionRefs = useRef<Array<HTMLInputElement | null>>([]);
  const pendingOptionFocusIndexRef = useRef<number | null>(null);
  // Delete-with-confirmation: the first DELETE (no force) doubles as a pre-check -- a 409
  // populates this instead of erroring, and nothing is deleted until "Delete Anyway" fires
  // the second DELETE with force=true. Cancel just clears this, no request sent.
  const [deleteFieldPrompt, setDeleteFieldPrompt] = useState<{
    id: string;
    label: string;
    detail: string;
  } | null>(null);

  // API Tokens tab state. Tokens are project-scoped (api_tokens.project_id is NOT NULL),
  // so this tab carries its own project picker independent of the main workspace header's.
  const [apiTokens, setApiTokens] = useState<ApiTokenItem[]>([]);
  const [tokenProjectScope, setTokenProjectScope] = useState<string>("");
  const [issuerCapabilityCeiling, setIssuerCapabilityCeiling] = useState<string[]>([]);
  const [newTokenName, setNewTokenName] = useState<string>("");
  const [newTokenExpiresAt, setNewTokenExpiresAt] = useState<string>("");
  const [newTokenCapabilities, setNewTokenCapabilities] = useState<Set<string>>(new Set());
  const [isCreatingToken, setIsCreatingToken] = useState<boolean>(false);
  // Deliberately separate from `apiTokens` (which only ever holds prefix/metadata after
  // the fact) -- the plaintext must never be merged into state that could linger, get
  // re-rendered after dismissal, or round-trip back from a refetch.
  const [justCreatedToken, setJustCreatedToken] = useState<{ plaintext: string; name: string } | null>(null);
  const [copyButtonLabel, setCopyButtonLabel] = useState<string>("Copy");

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
      fetchCustomFields();
    }
  }, [isOpen]);

  // Reload the selected user's overrides whenever the selected user or scope changes.
  useEffect(() => {
    if (activeTab === "MATRIX" && selectedUserId) {
      fetchOverrides(selectedUserId, overrideScope);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedUserId, overrideScope, activeTab]);

  // Default the token tab's project scope once the project list is available.
  useEffect(() => {
    if (!tokenProjectScope && projects.length > 0) {
      setTokenProjectScope(projects[0].id);
    }
  }, [projects, tokenProjectScope]);

  // Reload the token list + issuer ceiling whenever the tab is active and the scope changes.
  useEffect(() => {
    if (isOpen && activeTab === "API_TOKENS" && tokenProjectScope) {
      fetchApiTokens(tokenProjectScope);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, activeTab, tokenProjectScope]);

  // The plaintext is shown exactly once -- clear it on tab switch, scope change, or close
  // so it can never reappear from a stale render after the user has moved on.
  useEffect(() => {
    if (!isOpen || activeTab !== "API_TOKENS") {
      setJustCreatedToken(null);
    }
  }, [isOpen, activeTab]);
  useEffect(() => {
    setJustCreatedToken(null);
  }, [tokenProjectScope]);

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

  const fetchCustomFields = async () => {
    try {
      const res = await fetch("/api/v1/admin/custom-fields", { headers: getAuthHeaders() });
      const data = await res.json();
      if (res.ok) {
        setCustomFields(data.definitions || []);
      }
    } catch {
      // Ignore -- the tab just shows an empty list
    }
  };

  const fetchApiTokens = async (projectId: string) => {
    try {
      const res = await fetch(`/api/v1/projects/${projectId}/api-tokens`, {
        headers: getAuthHeaders(),
      });
      const data = await res.json();
      if (res.ok) {
        setApiTokens(data.tokens || []);
        setIssuerCapabilityCeiling(data.issuer_capability_ceiling || []);
      }
    } catch {
      // Ignore -- the tab just shows an empty list
    }
  };

  const handleCreateToken = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setIsCreatingToken(true);
    try {
      const res = await fetch(`/api/v1/projects/${tokenProjectScope}/api-tokens`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...getAuthHeaders(),
        },
        body: JSON.stringify({
          name: newTokenName,
          capabilities: Array.from(newTokenCapabilities),
          expires_at: newTokenExpiresAt ? new Date(newTokenExpiresAt).toISOString() : null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || data.error || "Failed to create token");
      }
      setJustCreatedToken({ plaintext: data.plaintext, name: data.token.name });
      setCopyButtonLabel("Copy");
      setNewTokenName("");
      setNewTokenExpiresAt("");
      setNewTokenCapabilities(new Set());
      fetchApiTokens(tokenProjectScope);
      fetchAuditLogs();
    } catch (err: any) {
      setErrorMessage(err.message || "Failed to create token");
    } finally {
      setIsCreatingToken(false);
    }
  };

  // One-step revoke, modeled on handleDeleteTemplate -- revocation has no "in use"
  // collision to warn about, so there's no confirmation dialog needed.
  const handleRevokeToken = async (tokenId: string) => {
    setErrorMessage(null);
    try {
      const res = await fetch(`/api/v1/projects/${tokenProjectScope}/api-tokens/${tokenId}`, {
        method: "DELETE",
        headers: getAuthHeaders(),
      });
      if (!res.ok && res.status !== 204) {
        const data = await res.json();
        throw new Error(data.error || "Failed to revoke token");
      }
      flashSuccess("Token revoked.");
      fetchApiTokens(tokenProjectScope);
      fetchAuditLogs();
    } catch (err: any) {
      setErrorMessage(err.message || "Failed to revoke token");
    }
  };

  const handleCopyToken = (plaintext: string) => {
    navigator.clipboard.writeText(plaintext).then(
      () => {
        setCopyButtonLabel("Copied!");
        setTimeout(() => setCopyButtonLabel("Copy"), 2000);
      },
      () => {
        setCopyButtonLabel("Copy failed");
        setTimeout(() => setCopyButtonLabel("Copy"), 2000);
      },
    );
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

  // --- Custom Fields tab handlers ---

  const handleSelectField = (fieldId: string) => {
    const field = customFields.find((f) => f.id === fieldId);
    if (!field) return;
    setSelectedFieldId(fieldId);
    setIsNewField(false);
    setDeleteFieldPrompt(null);
    setFieldEntityType(field.entity_type);
    setFieldName(field.name);
    setFieldLabel(field.field_label);
    setFieldType(field.field_type);
    setFieldIsRequired(field.is_required);
    setFieldDefaultValue(field.default_value ?? "");
    setFieldValidationRegex(field.validation_regex ?? "");
    setFieldOptions(field.options.map((o) => ({ ...o })));
  };

  const handleNewField = () => {
    setSelectedFieldId(null);
    setIsNewField(true);
    setDeleteFieldPrompt(null);
    setFieldEntityType("TestCase");
    setFieldName("");
    setFieldLabel("");
    setFieldType("TEXT");
    setFieldIsRequired(false);
    setFieldDefaultValue("");
    setFieldValidationRegex("");
    setFieldOptions([]);
  };

  const isOptionType = fieldType === "SINGLE_SELECT" || fieldType === "MULTI_SELECT";

  const addFieldOption = () => {
    setFieldOptions((prev) => {
      pendingOptionFocusIndexRef.current = prev.length;
      return [...prev, { option_label: "", option_value: "" }];
    });
  };

  // Focuses the newly-added option row's input once it actually exists in the DOM.
  // useLayoutEffect (not useEffect) so focus lands before paint, same reasoning as
  // App.tsx's identical step-editor effect.
  useLayoutEffect(() => {
    if (pendingOptionFocusIndexRef.current !== null) {
      const idx = pendingOptionFocusIndexRef.current;
      pendingOptionFocusIndexRef.current = null;
      fieldOptionRefs.current[idx]?.focus();
    }
  }, [fieldOptions.length]);

  const updateFieldOption = (index: number, patch: Partial<CustomFieldOption>) => {
    setFieldOptions((prev) => prev.map((o, i) => (i === index ? { ...o, ...patch } : o)));
  };

  const removeFieldOption = (index: number) => {
    setFieldOptions((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSaveField = async () => {
    setErrorMessage(null);
    setSuccessMessage(null);
    setIsSavingField(true);
    const wasNewField = isNewField;

    const basePayload = {
      field_label: fieldLabel,
      is_required: fieldIsRequired,
      default_value: fieldDefaultValue || null,
      validation_regex: fieldType === "TEXT" ? fieldValidationRegex || null : null,
      options: isOptionType ? fieldOptions : undefined,
    };

    try {
      const res = await fetch(
        isNewField ? "/api/v1/admin/custom-fields" : `/api/v1/admin/custom-fields/${selectedFieldId}`,
        {
          method: isNewField ? "POST" : "PUT",
          headers: { "Content-Type": "application/json", ...getAuthHeaders() },
          body: JSON.stringify(
            isNewField ? { entity_type: fieldEntityType, name: fieldName, field_type: fieldType, ...basePayload } : basePayload,
          ),
        },
      );

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to save custom field");
      }

      await fetchCustomFields();
      setIsNewField(false);
      setSelectedFieldId(data.definition.id);
      // seeded_count is only ever present on a create response -- a default value just got
      // frozen into a real row for that many pre-existing records (see
      // CustomFieldRepository.seedDefaultValueForAllEntities), worth surfacing since it's not
      // otherwise visible anywhere. applied_default_count is the update-path equivalent --
      // present whenever the save left the field required with a usable default, counting
      // any existing explicit-blank value rows that just got switched to that default (see
      // CustomFieldRepository.applyDefaultToBlankValues).
      const appliedCount = wasNewField ? data.seeded_count : data.applied_default_count;
      const seededSuffix =
        typeof appliedCount === "number" && appliedCount > 0
          ? ` Default applied to ${appliedCount} existing record${appliedCount === 1 ? "" : "s"}.`
          : "";
      flashSuccess((wasNewField ? "✓ Custom field created." : "✓ Custom field saved.") + seededSuffix);
    } catch (err: any) {
      setErrorMessage(err.message || "Failed to save custom field");
    } finally {
      setIsSavingField(false);
    }
  };

  // Two-step delete: the first DELETE (no force) doubles as a pre-check. A 409 means the
  // field has recorded values -- nothing is deleted yet, so populate the warning prompt
  // instead of erroring. A 204 means it was unused and is already gone.
  const handleDeleteFieldClick = async (field: CustomFieldDefinition) => {
    setErrorMessage(null);
    try {
      const res = await fetch(`/api/v1/admin/custom-fields/${field.id}`, {
        method: "DELETE",
        headers: getAuthHeaders(),
      });

      if (res.status === 409) {
        const data = await res.json();
        setDeleteFieldPrompt({
          id: field.id,
          label: field.field_label,
          detail: data.detail || `"${field.field_label}" has recorded values and cannot be deleted without confirmation.`,
        });
        return;
      }
      if (!res.ok && res.status !== 204) {
        const data = await res.json();
        throw new Error(data.error || "Failed to delete custom field");
      }

      if (selectedFieldId === field.id) {
        setSelectedFieldId(null);
        setIsNewField(false);
      }
      fetchCustomFields();
      flashSuccess(`✓ Field "${field.field_label}" deleted.`);
    } catch (err: any) {
      setErrorMessage(err.message || "Failed to delete custom field");
    }
  };

  const handleConfirmDeleteField = async () => {
    if (!deleteFieldPrompt) return;
    setErrorMessage(null);
    try {
      const res = await fetch(`/api/v1/admin/custom-fields/${deleteFieldPrompt.id}?force=true`, {
        method: "DELETE",
        headers: getAuthHeaders(),
      });
      if (!res.ok && res.status !== 204) {
        const data = await res.json();
        throw new Error(data.error || "Failed to delete custom field");
      }

      if (selectedFieldId === deleteFieldPrompt.id) {
        setSelectedFieldId(null);
        setIsNewField(false);
      }
      const label = deleteFieldPrompt.label;
      setDeleteFieldPrompt(null);
      fetchCustomFields();
      flashSuccess(`✓ Field "${label}" and its recorded data have been deleted.`);
    } catch (err: any) {
      setErrorMessage(err.message || "Failed to delete custom field");
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
            onClick={() => setActiveTab("CUSTOM_FIELDS")}
            style={{
              padding: "10px 16px",
              backgroundColor: "transparent",
              border: "none",
              borderBottom:
                activeTab === "CUSTOM_FIELDS" ? "2px solid #38bdf8" : "none",
              color: activeTab === "CUSTOM_FIELDS" ? "#38bdf8" : "#94a3b8",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            🏷️ Custom Fields ({customFields.length})
          </button>
          <button
            onClick={() => setActiveTab("API_TOKENS")}
            style={{
              padding: "10px 16px",
              backgroundColor: "transparent",
              border: "none",
              borderBottom:
                activeTab === "API_TOKENS" ? "2px solid #38bdf8" : "none",
              color: activeTab === "API_TOKENS" ? "#38bdf8" : "#94a3b8",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            🔑 API Tokens
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

        {/* TAB: CUSTOM FIELDS -- global (not per-project) admin-defined fields on Test Cases
            and Test Suites, edited by testers in Specification mode's case/suite detail. */}
        {activeTab === "CUSTOM_FIELDS" && (
          <div style={{ display: "flex", gap: "20px", flex: 1, overflow: "hidden" }}>
            {/* Field List, grouped by entity type */}
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
                <span>CUSTOM FIELDS</span>
                <button
                  onClick={handleNewField}
                  title="New Custom Field"
                  style={{ background: "none", border: "none", color: "#38bdf8", cursor: "pointer", fontSize: "14px" }}
                >
                  ➕
                </button>
              </div>
              {(["TestCase", "TestSuite"] as const).map((entityType) => (
                <div key={entityType}>
                  <div
                    style={{
                      padding: "6px 12px",
                      fontSize: "10px",
                      color: "#64748b",
                      textTransform: "uppercase",
                      backgroundColor: "#0f172a",
                    }}
                  >
                    {entityType === "TestCase" ? "Test Case Fields" : "Test Suite Fields"}
                  </div>
                  {customFields
                    .filter((f) => f.entity_type === entityType)
                    .map((f) => (
                      <div
                        key={f.id}
                        onClick={() => handleSelectField(f.id)}
                        style={{
                          padding: "10px 12px",
                          cursor: "pointer",
                          backgroundColor: selectedFieldId === f.id ? "#0284c7" : "transparent",
                          color: selectedFieldId === f.id ? "#fff" : "#cbd5e1",
                          borderBottom: "1px solid #0f172a",
                          fontSize: "12px",
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                        }}
                      >
                        <div>
                          <div style={{ fontWeight: 600 }}>{f.field_label}</div>
                          <div style={{ fontSize: "10px", opacity: 0.8 }}>
                            {CUSTOM_FIELD_TYPE_OPTIONS.find((t) => t.value === f.field_type)?.label}
                            {f.is_required ? " · required" : ""}
                          </div>
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteFieldClick(f);
                          }}
                          title="Delete Field"
                          style={{ background: "none", border: "none", color: "#f87171", cursor: "pointer", fontSize: "12px" }}
                        >
                          🗑️
                        </button>
                      </div>
                    ))}
                  {customFields.filter((f) => f.entity_type === entityType).length === 0 && (
                    <div style={{ padding: "10px 12px", fontSize: "11px", color: "#64748b" }}>None defined yet.</div>
                  )}
                </div>
              ))}
            </div>

            {/* Field Detail Form */}
            <div
              style={{
                flex: 1,
                backgroundColor: deleteFieldPrompt ? "#78350f" : "#1e293b",
                padding: "16px",
                borderRadius: "6px",
                border: `1px solid ${deleteFieldPrompt ? "#92400e" : "#334155"}`,
                overflowY: "auto",
              }}
            >
              {deleteFieldPrompt ? (
                <div>
                  <h3 style={{ fontSize: "15px", fontWeight: 700, margin: "0 0 12px 0", color: "#fbbf24" }}>
                    ⚠️ Confirm Deletion
                  </h3>
                  <p style={{ fontSize: "12px", color: "#fde68a", lineHeight: 1.5 }}>{deleteFieldPrompt.detail}</p>
                  <div style={{ display: "flex", gap: "8px", marginTop: "16px" }}>
                    <button
                      onClick={() => setDeleteFieldPrompt(null)}
                      style={{
                        padding: "8px 16px",
                        backgroundColor: "#334155",
                        border: "none",
                        borderRadius: "4px",
                        color: "#fff",
                        fontWeight: 600,
                        fontSize: "12px",
                        cursor: "pointer",
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleConfirmDeleteField}
                      style={{
                        padding: "8px 16px",
                        backgroundColor: "#dc2626",
                        border: "none",
                        borderRadius: "4px",
                        color: "#fff",
                        fontWeight: 600,
                        fontSize: "12px",
                        cursor: "pointer",
                      }}
                    >
                      Delete Anyway
                    </button>
                  </div>
                </div>
              ) : selectedFieldId || isNewField ? (
                <div>
                  <h3 style={{ fontSize: "15px", fontWeight: 700, margin: "0 0 12px 0", color: "#38bdf8" }}>
                    {isNewField ? "New Custom Field" : `Editing: ${fieldLabel}`}
                  </h3>

                  <div style={{ display: "flex", gap: "10px", marginBottom: "10px" }}>
                    <div style={{ flex: 1 }}>
                      <label style={{ fontSize: "11px", color: "#94a3b8", display: "block", marginBottom: "2px" }}>
                        Applies To
                      </label>
                      <select
                        value={fieldEntityType}
                        onChange={(e) => setFieldEntityType(e.target.value as CustomFieldEntityType)}
                        disabled={!isNewField}
                        style={{
                          width: "100%",
                          boxSizing: "border-box",
                          padding: "6px 8px",
                          backgroundColor: "#0f172a",
                          border: "1px solid #475569",
                          borderRadius: "4px",
                          color: "#fff",
                          fontSize: "12px",
                          opacity: isNewField ? 1 : 0.6,
                        }}
                      >
                        <option value="TestCase">Test Case</option>
                        <option value="TestSuite">Test Suite</option>
                      </select>
                    </div>
                    <div style={{ flex: 1 }}>
                      <label style={{ fontSize: "11px", color: "#94a3b8", display: "block", marginBottom: "2px" }}>
                        Field Type
                      </label>
                      <select
                        value={fieldType}
                        onChange={(e) => {
                          const next = e.target.value as CustomFieldType;
                          setFieldType(next);
                          // CHECKBOX fields have no "Required" option (see below) -- clear any
                          // stale is_required from a previous type selection so it can't be
                          // silently submitted anyway.
                          if (next === "CHECKBOX") setFieldIsRequired(false);
                        }}
                        disabled={!isNewField}
                        style={{
                          width: "100%",
                          boxSizing: "border-box",
                          padding: "6px 8px",
                          backgroundColor: "#0f172a",
                          border: "1px solid #475569",
                          borderRadius: "4px",
                          color: "#fff",
                          fontSize: "12px",
                          opacity: isNewField ? 1 : 0.6,
                        }}
                      >
                        {CUSTOM_FIELD_TYPE_OPTIONS.map((t) => (
                          <option key={t.value} value={t.value}>
                            {t.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div style={{ marginBottom: "10px" }}>
                    <label style={{ fontSize: "11px", color: "#94a3b8", display: "block", marginBottom: "2px" }}>
                      Name (internal key)
                    </label>
                    <input
                      type="text"
                      value={fieldName}
                      onChange={(e) => setFieldName(e.target.value)}
                      disabled={!isNewField}
                      style={{
                        width: "100%",
                        boxSizing: "border-box",
                        padding: "6px 8px",
                        backgroundColor: "#0f172a",
                        border: "1px solid #475569",
                        borderRadius: "4px",
                        color: "#fff",
                        fontSize: "12px",
                        opacity: isNewField ? 1 : 0.6,
                      }}
                    />
                  </div>

                  <div style={{ marginBottom: "10px" }}>
                    <label style={{ fontSize: "11px", color: "#94a3b8", display: "block", marginBottom: "2px" }}>
                      Label (shown to testers)
                    </label>
                    <input
                      type="text"
                      value={fieldLabel}
                      onChange={(e) => setFieldLabel(e.target.value)}
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

                  {fieldType !== "CHECKBOX" && (
                    <div style={{ marginBottom: "10px" }}>
                      <button
                        onClick={() => setFieldIsRequired((prev) => !prev)}
                        style={{
                          padding: "3px 8px",
                          borderRadius: "4px",
                          fontSize: "10px",
                          fontWeight: 700,
                          border: fieldIsRequired ? "1px solid #22c55e" : "1px solid #4b5563",
                          backgroundColor: fieldIsRequired ? "rgba(34, 197, 94, 0.15)" : "transparent",
                          color: fieldIsRequired ? "#4ade80" : "#9ca3af",
                          cursor: "pointer",
                        }}
                      >
                        {fieldIsRequired ? "✓" : "—"} Required
                      </button>
                    </div>
                  )}

                  <div style={{ marginBottom: "10px" }}>
                    <label style={{ fontSize: "11px", color: "#94a3b8", display: "block", marginBottom: "2px" }}>
                      Default Value
                    </label>
                    {fieldType === "CHECKBOX" ? (
                      // A CHECKBOX field's default is itself a boolean -- a free-text box asking
                      // the admin to type "true"/"1" was never a good fit here. Unchecked means
                      // no default (submitted as null, same as leaving the text box blank for
                      // every other type); checked means a default of true.
                      <button
                        onClick={() => setFieldDefaultValue((prev) => (prev === "true" ? "" : "true"))}
                        title={fieldDefaultValue === "true" ? "Defaults to checked" : "No default (unchecked)"}
                        style={{
                          width: "16px",
                          height: "16px",
                          borderRadius: "3px",
                          border: fieldDefaultValue === "true" ? "1px solid #22c55e" : "1px solid #4b5563",
                          backgroundColor: fieldDefaultValue === "true" ? "#15803d" : "transparent",
                          cursor: "pointer",
                        }}
                      />
                    ) : fieldType === "DATE" ? (
                      // A real date picker (not a free-text box) -- gets the same
                      // "what format?" question CustomFieldEditor.tsx's own DATE control
                      // already answers, by construction, instead of needing help text to
                      // explain it (a native date input's own placeholder attribute is
                      // ignored by every browser, so text guidance has to live outside it).
                      <>
                        <input
                          type="date"
                          value={fieldDefaultValue}
                          onChange={(e) => setFieldDefaultValue(e.target.value)}
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
                        <div style={{ fontSize: "10px", color: "#64748b", marginTop: "4px" }}>
                          Pick a date, or type one as YYYY-MM-DD.
                        </div>
                      </>
                    ) : fieldType === "SINGLE_SELECT" ? (
                      // A real dropdown built from the Options list below, instead of a free-text
                      // box asking the admin to retype an option's value by hand -- it always
                      // reflects whatever's currently in fieldOptions, so adding/renaming/removing
                      // an option updates this list on every render with no extra wiring.
                      <select
                        value={fieldDefaultValue}
                        onChange={(e) => setFieldDefaultValue(e.target.value)}
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
                        <option value="">No default</option>
                        {fieldOptions
                          .filter((opt) => opt.option_value !== "")
                          .map((opt) => (
                            <option key={opt.option_value} value={opt.option_value}>
                              {opt.option_label}
                            </option>
                          ))}
                      </select>
                    ) : fieldType === "MULTI_SELECT" ? (
                      // Pill toggles matching CustomFieldEditor.tsx's own MULTI_SELECT control
                      // exactly, built from the Options list below -- same live-updates-with-
                      // fieldOptions approach as the SINGLE_SELECT dropdown above. The default is
                      // stored as the same JSON-array string custom_field_values.json_value
                      // already uses. A stale option value no longer in fieldOptions (e.g. an
                      // option was renamed) simply isn't rendered as a pill -- it's dropped the
                      // next time any pill here is toggled, never silently mutated behind the
                      // admin's back while they're just editing an option's text.
                      (() => {
                        let parsedDefault: string[] = [];
                        try {
                          const parsed = JSON.parse(fieldDefaultValue || "[]");
                          if (Array.isArray(parsed)) {
                            parsedDefault = parsed.filter((v): v is string => typeof v === "string");
                          }
                        } catch {
                          parsedDefault = [];
                        }
                        const allowedValues = new Set(fieldOptions.map((o) => o.option_value));
                        const selectedDefaults = new Set(parsedDefault.filter((v) => allowedValues.has(v)));
                        return (
                          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                            {fieldOptions.length === 0 && (
                              <span style={{ fontSize: "11px", color: "#64748b" }}>Add options below first.</span>
                            )}
                            {fieldOptions.map((opt) => {
                              const isOn = selectedDefaults.has(opt.option_value);
                              return (
                                <button
                                  key={opt.option_value}
                                  onClick={() => {
                                    const next = new Set(selectedDefaults);
                                    if (isOn) next.delete(opt.option_value);
                                    else next.add(opt.option_value);
                                    setFieldDefaultValue(next.size > 0 ? JSON.stringify(Array.from(next)) : "");
                                  }}
                                  style={{
                                    padding: "3px 8px",
                                    borderRadius: "4px",
                                    fontSize: "10px",
                                    fontWeight: 700,
                                    border: isOn ? "1px solid #22c55e" : "1px solid #4b5563",
                                    backgroundColor: isOn ? "rgba(34, 197, 94, 0.15)" : "transparent",
                                    color: isOn ? "#4ade80" : "#9ca3af",
                                    cursor: "pointer",
                                  }}
                                >
                                  {isOn ? "✓" : "—"} {opt.option_label}
                                </button>
                              );
                            })}
                          </div>
                        );
                      })()
                    ) : (
                      <input
                        type="text"
                        value={fieldDefaultValue}
                        onChange={(e) => setFieldDefaultValue(e.target.value)}
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
                    )}
                  </div>

                  {fieldType === "TEXT" && (
                    <div style={{ marginBottom: "10px" }}>
                      <label style={{ fontSize: "11px", color: "#94a3b8", display: "block", marginBottom: "2px" }}>
                        Validation Regex (optional)
                      </label>
                      <input
                        type="text"
                        value={fieldValidationRegex}
                        onChange={(e) => setFieldValidationRegex(e.target.value)}
                        placeholder="e.g. ^[A-Z]+-\d+$"
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
                  )}

                  {isOptionType && (
                    <div style={{ marginBottom: "14px" }}>
                      <label style={{ fontSize: "11px", color: "#94a3b8", display: "block", marginBottom: "6px" }}>
                        Options
                      </label>
                      {fieldOptions.map((opt, i) => (
                        <div key={i} style={{ display: "flex", gap: "6px", marginBottom: "6px" }}>
                          <input
                            ref={(el) => {
                              fieldOptionRefs.current[i] = el;
                            }}
                            type="text"
                            placeholder="Option"
                            value={opt.option_label}
                            onChange={(e) => updateFieldOption(i, { option_label: e.target.value, option_value: e.target.value })}
                            style={{
                              flex: 1,
                              padding: "5px 8px",
                              backgroundColor: "#0f172a",
                              border: "1px solid #475569",
                              borderRadius: "4px",
                              color: "#fff",
                              fontSize: "11px",
                            }}
                          />
                          <button
                            onClick={() => removeFieldOption(i)}
                            style={{ background: "none", border: "none", color: "#f87171", cursor: "pointer", fontSize: "12px" }}
                          >
                            🗑️
                          </button>
                        </div>
                      ))}
                      <button
                        onClick={addFieldOption}
                        style={{
                          padding: "4px 10px",
                          backgroundColor: "transparent",
                          border: "1px dashed #475569",
                          borderRadius: "4px",
                          color: "#94a3b8",
                          fontSize: "11px",
                          cursor: "pointer",
                        }}
                      >
                        + Add Option
                      </button>
                    </div>
                  )}

                  <button
                    onClick={handleSaveField}
                    disabled={isSavingField}
                    style={{
                      padding: "8px 16px",
                      backgroundColor: isSavingField ? "#166534" : "#16a34a",
                      border: "none",
                      borderRadius: "4px",
                      color: "#fff",
                      fontWeight: 600,
                      fontSize: "12px",
                      cursor: isSavingField ? "default" : "pointer",
                      opacity: isSavingField ? 0.8 : 1,
                    }}
                  >
                    {isSavingField ? "Saving..." : isNewField ? "Create Field" : "Save Field"}
                  </button>
                </div>
              ) : (
                <div style={{ color: "#64748b", fontSize: "13px" }}>
                  Select a custom field from the list, or create a new one.
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB: API TOKENS -- project-scoped machine credentials for CI/automation callers.
            Capabilities are capped at the issuing admin's own effective permissions on the
            selected project, and SYSTEM_ADMIN can never be granted to a token (see
            apps/server/src/routes/apiTokens.ts). */}
        {activeTab === "API_TOKENS" && (
          <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden", gap: "12px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <label style={{ fontSize: "11px", color: "#94a3b8", fontWeight: 700 }}>PROJECT</label>
              <select
                value={tokenProjectScope}
                onChange={(e) => setTokenProjectScope(e.target.value)}
                style={{
                  padding: "6px 10px",
                  backgroundColor: "#0f172a",
                  border: "1px solid #334155",
                  borderRadius: "4px",
                  color: "#e2e8f0",
                  fontSize: "12px",
                }}
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>

            {justCreatedToken && (
              <div
                style={{
                  padding: "12px",
                  backgroundColor: "rgba(34, 197, 94, 0.1)",
                  border: "1px solid #22c55e",
                  borderRadius: "6px",
                }}
              >
                <div style={{ fontSize: "12px", fontWeight: 700, color: "#4ade80", marginBottom: "6px" }}>
                  ✓ Token "{justCreatedToken.name}" created
                </div>
                <div style={{ fontSize: "11px", color: "#fca5a5", marginBottom: "8px" }}>
                  Copy this token now -- for security, it will never be shown again.
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <code
                    style={{
                      flex: 1,
                      padding: "8px 10px",
                      backgroundColor: "#0f172a",
                      border: "1px solid #334155",
                      borderRadius: "4px",
                      color: "#e2e8f0",
                      fontSize: "12px",
                      overflowX: "auto",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {justCreatedToken.plaintext}
                  </code>
                  <button
                    onClick={() => handleCopyToken(justCreatedToken.plaintext)}
                    style={{
                      padding: "8px 12px",
                      backgroundColor: "#16a34a",
                      border: "none",
                      borderRadius: "4px",
                      color: "#fff",
                      fontWeight: 600,
                      fontSize: "12px",
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {copyButtonLabel}
                  </button>
                  <button
                    onClick={() => setJustCreatedToken(null)}
                    style={{
                      padding: "8px 10px",
                      backgroundColor: "transparent",
                      border: "1px solid #4b5563",
                      borderRadius: "4px",
                      color: "#9ca3af",
                      fontSize: "12px",
                      cursor: "pointer",
                    }}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            )}

            <div style={{ display: "flex", gap: "20px", flex: 1, overflow: "hidden" }}>
              {/* Token list */}
              <div
                style={{
                  flex: 1,
                  backgroundColor: "#1e293b",
                  borderRadius: "6px",
                  border: "1px solid #334155",
                  overflowY: "auto",
                  padding: "12px",
                }}
              >
                {apiTokens.length === 0 ? (
                  <div style={{ color: "#64748b", fontSize: "13px" }}>
                    No tokens for this project yet.
                  </div>
                ) : (
                  apiTokens.map((t) => (
                    <div
                      key={t.id}
                      style={{
                        padding: "10px",
                        marginBottom: "8px",
                        backgroundColor: "#0f172a",
                        border: "1px solid #334155",
                        borderRadius: "6px",
                        opacity: t.is_revoked ? 0.5 : 1,
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                        <div>
                          <div style={{ fontSize: "13px", fontWeight: 700, color: "#e2e8f0" }}>
                            {t.name}
                            {t.is_revoked && (
                              <span style={{ marginLeft: "8px", fontSize: "10px", color: "#f87171", fontWeight: 700 }}>
                                REVOKED
                              </span>
                            )}
                          </div>
                          <code style={{ fontSize: "11px", color: "#64748b" }}>{t.token_prefix}…</code>
                        </div>
                        {!t.is_revoked && (
                          <button
                            onClick={() => handleRevokeToken(t.id)}
                            style={{
                              padding: "4px 10px",
                              backgroundColor: "transparent",
                              border: "1px solid #ef4444",
                              borderRadius: "4px",
                              color: "#f87171",
                              fontSize: "11px",
                              fontWeight: 600,
                              cursor: "pointer",
                            }}
                          >
                            Revoke
                          </button>
                        )}
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "6px" }}>
                        {t.capabilities.map((c) => (
                          <span
                            key={c}
                            style={{
                              padding: "2px 6px",
                              borderRadius: "4px",
                              fontSize: "10px",
                              fontWeight: 700,
                              border: "1px solid #4b5563",
                              color: "#9ca3af",
                            }}
                          >
                            {c}
                          </span>
                        ))}
                      </div>
                      <div style={{ fontSize: "10px", color: "#64748b", marginTop: "6px" }}>
                        Created {new Date(t.created_at).toLocaleString()}
                        {t.expires_at && ` · Expires ${new Date(t.expires_at).toLocaleString()}`}
                        {t.last_used_at
                          ? ` · Last used ${new Date(t.last_used_at).toLocaleString()}`
                          : " · Never used"}
                      </div>
                    </div>
                  ))
                )}
              </div>

              {/* Create form */}
              <div
                style={{
                  width: "340px",
                  backgroundColor: "#1e293b",
                  borderRadius: "6px",
                  border: "1px solid #334155",
                  padding: "14px",
                  overflowY: "auto",
                }}
              >
                <h4 style={{ fontSize: "12px", fontWeight: 700, margin: "0 0 10px 0", color: "#e2e8f0" }}>
                  New Token
                </h4>
                <input
                  type="text"
                  placeholder="Token name (e.g. CI runner)"
                  value={newTokenName}
                  onChange={(e) => setNewTokenName(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "8px",
                    marginBottom: "8px",
                    backgroundColor: "#0f172a",
                    border: "1px solid #334155",
                    borderRadius: "4px",
                    color: "#e2e8f0",
                    fontSize: "12px",
                    boxSizing: "border-box",
                  }}
                />
                <label style={{ fontSize: "10px", color: "#64748b", display: "block", marginBottom: "2px" }}>
                  Expires (optional)
                </label>
                <input
                  type="date"
                  value={newTokenExpiresAt}
                  onChange={(e) => setNewTokenExpiresAt(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "8px",
                    marginBottom: "12px",
                    backgroundColor: "#0f172a",
                    border: "1px solid #334155",
                    borderRadius: "4px",
                    color: "#e2e8f0",
                    fontSize: "12px",
                    boxSizing: "border-box",
                  }}
                />

                <div style={{ fontSize: "11px", fontWeight: 700, color: "#e2e8f0", marginBottom: "6px" }}>
                  Capabilities
                </div>
                {Array.from(
                  new Set(
                    permissionRegistry
                      .filter((p) => p.key !== "SYSTEM_ADMIN" && issuerCapabilityCeiling.includes(p.key))
                      .map((p) => p.module),
                  ),
                ).map((moduleName) => (
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
                        .filter((p) => p.module === moduleName && p.key !== "SYSTEM_ADMIN" && issuerCapabilityCeiling.includes(p.key))
                        .map((p) => {
                          const isOn = newTokenCapabilities.has(p.key);
                          return (
                            <button
                              key={p.key}
                              onClick={() =>
                                setNewTokenCapabilities((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(p.key)) next.delete(p.key);
                                  else next.add(p.key);
                                  return next;
                                })
                              }
                              title={p.description}
                              style={{
                                padding: "3px 8px",
                                borderRadius: "4px",
                                fontSize: "10px",
                                fontWeight: 700,
                                border: isOn ? "1px solid #22c55e" : "1px solid #4b5563",
                                backgroundColor: isOn ? "rgba(34, 197, 94, 0.15)" : "transparent",
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
                ))}
                {issuerCapabilityCeiling.filter((k) => k !== "SYSTEM_ADMIN").length === 0 && (
                  <div style={{ color: "#64748b", fontSize: "11px", marginBottom: "10px" }}>
                    You have no grantable permissions on this project.
                  </div>
                )}

                <button
                  onClick={handleCreateToken}
                  disabled={isCreatingToken || !newTokenName || newTokenCapabilities.size === 0}
                  style={{
                    marginTop: "8px",
                    padding: "8px 16px",
                    backgroundColor: isCreatingToken ? "#166534" : "#16a34a",
                    border: "none",
                    borderRadius: "4px",
                    color: "#fff",
                    fontWeight: 600,
                    fontSize: "12px",
                    cursor: isCreatingToken ? "default" : "pointer",
                    opacity: isCreatingToken || !newTokenName || newTokenCapabilities.size === 0 ? 0.6 : 1,
                  }}
                >
                  {isCreatingToken ? "Creating..." : "Create Token"}
                </button>
              </div>
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
