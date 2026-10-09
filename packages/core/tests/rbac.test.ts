import { describe, it, expect } from 'vitest';
import {
  PERMISSION_REGISTRY,
  PERMISSION_KEYS,
  DEFAULT_ROLE_PERMISSIONS,
  DEFAULT_ROLE_NAMES,
  applyPermissionOverrides,
} from '../src/index.js';

describe('RBAC permission registry', () => {
  it('has exactly 19 entries, all with unique keys', () => {
    expect(PERMISSION_REGISTRY).toHaveLength(19);
    expect(PERMISSION_KEYS).toHaveLength(19);
    expect(new Set(PERMISSION_KEYS).size).toBe(19);
  });

  it('every entry has a non-empty key, description, and module', () => {
    for (const p of PERMISSION_REGISTRY) {
      expect(p.key.length).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(0);
      expect(p.module.length).toBeGreaterThan(0);
    }
  });

  it('includes the known permission keys', () => {
    expect(PERMISSION_KEYS).toEqual(
      expect.arrayContaining([
        'SYSTEM_ADMIN',
        'USER_MANAGE',
        'PLAN_MANAGE',
        'EXECUTE_RUN',
        'EXECUTE_OVERWRITE',
        'SPEC_VIEW',
      ])
    );
  });

  it('DEFAULT_ROLE_PERMISSIONS defines exactly the 5 built-in roles, each using only registered keys', () => {
    expect(DEFAULT_ROLE_NAMES.sort()).toEqual(
      ['Admin', 'Automation Service', 'Test Lead', 'Tester', 'Viewer'].sort()
    );
    for (const roleName of DEFAULT_ROLE_NAMES) {
      for (const key of DEFAULT_ROLE_PERMISSIONS[roleName]) {
        expect(PERMISSION_KEYS).toContain(key);
      }
    }
    expect(DEFAULT_ROLE_PERMISSIONS.Admin).toContain('SYSTEM_ADMIN');
  });

  it('CUSTOM_FIELD_MANAGE is granted only to Admin, not the other 4 built-in roles', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.Admin).toContain('CUSTOM_FIELD_MANAGE');
    for (const roleName of DEFAULT_ROLE_NAMES) {
      if (roleName === 'Admin') continue;
      expect(DEFAULT_ROLE_PERMISSIONS[roleName]).not.toContain('CUSTOM_FIELD_MANAGE');
    }
  });

  it('SPEC_CREATE/SPEC_EDIT/SPEC_APPROVE/SPEC_DELETE are registered and granted per role as intended -- a regression guard now that they are finally load-bearing (Spec-mode suite/case CRUD)', () => {
    for (const key of ['SPEC_CREATE', 'SPEC_EDIT', 'SPEC_APPROVE', 'SPEC_DELETE']) {
      expect(PERMISSION_KEYS).toContain(key);
    }
    // Admin and Test Lead hold all 4.
    for (const roleName of ['Admin', 'Test Lead']) {
      for (const key of ['SPEC_CREATE', 'SPEC_EDIT', 'SPEC_APPROVE', 'SPEC_DELETE']) {
        expect(DEFAULT_ROLE_PERMISSIONS[roleName]).toContain(key);
      }
    }
    // Tester holds create/edit but not approve/delete.
    expect(DEFAULT_ROLE_PERMISSIONS.Tester).toContain('SPEC_CREATE');
    expect(DEFAULT_ROLE_PERMISSIONS.Tester).toContain('SPEC_EDIT');
    expect(DEFAULT_ROLE_PERMISSIONS.Tester).not.toContain('SPEC_APPROVE');
    expect(DEFAULT_ROLE_PERMISSIONS.Tester).not.toContain('SPEC_DELETE');
    // Viewer and Automation Service hold none of the 4.
    for (const roleName of ['Viewer', 'Automation Service']) {
      for (const key of ['SPEC_CREATE', 'SPEC_EDIT', 'SPEC_APPROVE', 'SPEC_DELETE']) {
        expect(DEFAULT_ROLE_PERMISSIONS[roleName]).not.toContain(key);
      }
    }
  });

  it('SPEC_AUTO_APPROVE is registered and granted to the same roles that hold SPEC_APPROVE', () => {
    expect(PERMISSION_KEYS).toContain('SPEC_AUTO_APPROVE');
    for (const roleName of ['Admin', 'Test Lead']) {
      expect(DEFAULT_ROLE_PERMISSIONS[roleName]).toContain('SPEC_AUTO_APPROVE');
    }
    for (const roleName of ['Tester', 'Viewer', 'Automation Service']) {
      expect(DEFAULT_ROLE_PERMISSIONS[roleName]).not.toContain('SPEC_AUTO_APPROVE');
    }
  });
});

describe('applyPermissionOverrides', () => {
  it('returns the base set unchanged when there are no overrides', () => {
    const result = applyPermissionOverrides(['SPEC_VIEW', 'EXECUTE_RUN'], []);
    expect(result.sort()).toEqual(['EXECUTE_RUN', 'SPEC_VIEW']);
  });

  it('adds a key not in the base set when is_granted is true', () => {
    const result = applyPermissionOverrides(['SPEC_VIEW'], [{ permission_key: 'PLAN_MANAGE', is_granted: true }]);
    expect(result.sort()).toEqual(['PLAN_MANAGE', 'SPEC_VIEW']);
  });

  it('removes a key that is in the base set when is_granted is false', () => {
    const result = applyPermissionOverrides(
      ['SPEC_VIEW', 'EXECUTE_RUN'],
      [{ permission_key: 'EXECUTE_RUN', is_granted: false }]
    );
    expect(result).toEqual(['SPEC_VIEW']);
  });

  it('a false override on a key not in the base set is a no-op', () => {
    const result = applyPermissionOverrides(['SPEC_VIEW'], [{ permission_key: 'PLAN_MANAGE', is_granted: false }]);
    expect(result).toEqual(['SPEC_VIEW']);
  });

  it('can revoke a key even from a full SYSTEM_ADMIN-derived base set', () => {
    const result = applyPermissionOverrides(PERMISSION_KEYS, [
      { permission_key: 'API_TOKEN_MANAGE', is_granted: false },
    ]);
    expect(result).not.toContain('API_TOKEN_MANAGE');
    expect(result).toContain('SYSTEM_ADMIN');
    expect(result).toHaveLength(PERMISSION_KEYS.length - 1);
  });

  it('applies overrides in order, so a later entry for the same key wins (project-scoped beats global when passed last)', () => {
    const globalOverrides = [{ permission_key: 'PLAN_MANAGE', is_granted: false }];
    const projectOverrides = [{ permission_key: 'PLAN_MANAGE', is_granted: true }];
    const result = applyPermissionOverrides(['SPEC_VIEW'], [...globalOverrides, ...projectOverrides]);
    expect(result).toContain('PLAN_MANAGE');
  });

  it('handles multiple distinct keys in one call', () => {
    const result = applyPermissionOverrides(
      ['SPEC_VIEW', 'EXECUTE_RUN'],
      [
        { permission_key: 'EXECUTE_RUN', is_granted: false },
        { permission_key: 'PLAN_MANAGE', is_granted: true },
        { permission_key: 'RUN_MANAGE', is_granted: true },
      ]
    );
    expect(result.sort()).toEqual(['PLAN_MANAGE', 'RUN_MANAGE', 'SPEC_VIEW']);
  });
});
