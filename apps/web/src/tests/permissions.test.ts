import { describe, it, expect } from 'vitest';
import { permissionFlags } from '../utils/permissions';

describe('permissionFlags', () => {
  it('gives nothing without permissions', () => {
    expect(Object.values(permissionFlags([])).every((v) => v === false)).toBe(true);
  });

  it('maps each permission to its flag', () => {
    expect(permissionFlags(['SPEC_VIEW', 'EXPORT_DATA'])).toMatchObject({
      hasSpecViewPermission: true,
      hasExportDataPermission: true,
      hasSpecEditPermission: false,
      hasPlanManagePermission: false,
      hasAdminPanelAccess: false,
    });
    expect(permissionFlags(['RUN_MANAGE']).hasRunManagePermission).toBe(true);
    expect(permissionFlags(['SPEC_APPROVE']).hasSpecApprovePermission).toBe(true);
  });

  it('SYSTEM_ADMIN counts as every permission except EXECUTE_RUN, which an admin lists anyway', () => {
    const flags = permissionFlags(['SYSTEM_ADMIN']);
    const { hasExecuteRunPermission, ...rest } = flags;
    expect(Object.values(rest).every(Boolean)).toBe(true);
    expect(hasExecuteRunPermission).toBe(false);
    expect(permissionFlags(['SYSTEM_ADMIN', 'EXECUTE_RUN']).hasExecuteRunPermission).toBe(true);
  });

  it('opens the Admin Panel to anyone managing users, custom fields, API tokens or webhooks', () => {
    for (const key of ['USER_MANAGE', 'CUSTOM_FIELD_MANAGE', 'API_TOKEN_MANAGE', 'WEBHOOK_MANAGE']) {
      expect(permissionFlags([key]).hasAdminPanelAccess).toBe(true);
    }
    expect(permissionFlags(['CUSTOM_FIELD_MANAGE']).hasUserManagePermission).toBe(false);
  });
});
