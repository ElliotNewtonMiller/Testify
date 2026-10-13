// What the signed-in user's permissions allow, as the flags the UI checks. Most count
// SYSTEM_ADMIN as holding the permission; hasExecuteRunPermission deliberately doesn't (an
// admin's permission list already includes EXECUTE_RUN).
export interface PermissionFlags {
  hasExecuteRunPermission: boolean;
  hasRunManagePermission: boolean;
  hasUserManagePermission: boolean;
  /** The Admin Panel holds users/roles, custom fields, API tokens and webhooks -- open to anyone
   * who manages any of them (each tab is then shown only to those with its permission). */
  hasAdminPanelAccess: boolean;
  hasProjectCreatePermission: boolean;
  hasProjectDeletePermission: boolean;
  hasPlanManagePermission: boolean;
  hasSpecCreatePermission: boolean;
  hasSpecEditPermission: boolean;
  hasSpecApprovePermission: boolean;
  hasSpecDeletePermission: boolean;
  hasImportDataPermission: boolean;
  hasExportDataPermission: boolean;
  hasSpecViewPermission: boolean;
  hasReportEmailPermission: boolean;
  hasWebhookManagePermission: boolean;
}

export function permissionFlags(permissions: string[]): PermissionFlags {
  const has = (key: string) => permissions.includes(key) || permissions.includes("SYSTEM_ADMIN");
  const hasUserManagePermission = has("USER_MANAGE");
  return {
    hasExecuteRunPermission: permissions.includes("EXECUTE_RUN"),
    hasRunManagePermission: has("RUN_MANAGE"),
    hasUserManagePermission,
    hasAdminPanelAccess:
      hasUserManagePermission ||
      permissions.includes("CUSTOM_FIELD_MANAGE") ||
      permissions.includes("API_TOKEN_MANAGE") ||
      permissions.includes("WEBHOOK_MANAGE"),
    hasProjectCreatePermission: has("PROJECT_CREATE"),
    hasProjectDeletePermission: has("PROJECT_DELETE"),
    hasPlanManagePermission: has("PLAN_MANAGE"),
    hasSpecCreatePermission: has("SPEC_CREATE"),
    hasSpecEditPermission: has("SPEC_EDIT"),
    hasSpecApprovePermission: has("SPEC_APPROVE"),
    hasSpecDeletePermission: has("SPEC_DELETE"),
    hasImportDataPermission: has("IMPORT_DATA"),
    hasExportDataPermission: has("EXPORT_DATA"),
    hasSpecViewPermission: has("SPEC_VIEW"),
    hasReportEmailPermission: has("REPORT_EMAIL"),
    hasWebhookManagePermission: has("WEBHOOK_MANAGE"),
  };
}
