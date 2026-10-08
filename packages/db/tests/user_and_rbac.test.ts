import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Kysely } from 'kysely';
import { createDbClient } from '../src/client.js';
import type { Database } from '../src/types.js';
import { migrateToLatest, migrateDownAll } from '../src/migrations/index.js';
import { UserRepository, RoleRepository, ProjectRepository } from '../src/repositories/index.js';
import { validatePasswordPolicy } from '../../core/src/security/passwordPolicy.js';
import { seedRbacRegistry } from '../src/seeds/seed_rbac_registry.js';



describe('Password Policy Validation Unit Tests', () => {
  it('rejects passwords under 8 characters', () => {
    expect(validatePasswordPolicy('Pass1!').valid).toBe(false);
  });

  it('rejects 8-15 character passwords missing uppercase, digit, or symbol', () => {
    expect(validatePasswordPolicy('password123').valid).toBe(false); // missing uppercase & symbol
    expect(validatePasswordPolicy('PASSWORD123').valid).toBe(false); // missing lowercase & symbol (needs symbol)
    expect(validatePasswordPolicy('Passwordabc').valid).toBe(false); // missing digit & symbol
  });

  it('accepts 8-15 character passwords meeting all complexity rules', () => {
    expect(validatePasswordPolicy('Pass123!').valid).toBe(true);
  });

  it('accepts 16+ character passphrases without special character requirements', () => {
    expect(validatePasswordPolicy('correct horse battery staple').valid).toBe(true);
  });
});

describe('User & Role Repositories', () => {
  let db: Kysely<Database>;
  let userRepo: UserRepository;
  let roleRepo: RoleRepository;

  beforeEach(async () => {
    db = createDbClient();
    await migrateToLatest(db);
    // Roles/permissions are now DB-backed (see role.repository.ts) rather than a hardcoded
    // in-memory map -- evaluatePermissions needs the built-in role templates seeded.
    await seedRbacRegistry(db);

    userRepo = new UserRepository(db);
    roleRepo = new RoleRepository(db);
  });

  afterEach(async () => {
    try {
      await migrateDownAll(db);
    } finally {
      await db.destroy();
    }
  });

  it('seeds initial omnipotent superuser (admin / password)', async () => {
    const admin = await userRepo.seedInitialAdmin({ password: 'password' });
    expect(admin).not.toBeNull();
    expect(admin.username).toBe('admin');
    expect(admin.email).toBe('admin@testify.local');

    const role = await roleRepo.getUserGlobalRole(admin.id);
    expect(role).toBe('Admin');

    const perms = await roleRepo.evaluatePermissions(admin.id);
    expect(perms).toContain('SYSTEM_ADMIN');
    expect(perms).toContain('USER_MANAGE');

    // Verify admin can log in with initial password
    const authed = await userRepo.verifyCredentials('admin', 'password');
    expect(authed).not.toBeNull();
    expect(authed?.id).toBe(admin.id);
  });

  it('seeds the first admin with the given password, optionally requiring a change, which a new password clears', async () => {
    const admin = await userRepo.seedInitialAdmin({ password: 'Generated-Secret-123', mustChangePassword: true });
    expect(admin.must_change_password).toBe(true);
    expect(await userRepo.verifyCredentials('admin', 'password')).toBeNull();
    expect(await userRepo.isCurrentPassword(admin.id, 'Generated-Secret-123')).toBe(true);

    // Only creates when there are no users at all.
    const again = await userRepo.seedInitialAdmin({ password: 'something-else-entirely' });
    expect(again.id).toBe(admin.id);
    expect(await userRepo.isCurrentPassword(admin.id, 'something-else-entirely')).toBe(false);

    const updated = await userRepo.updateCredentials({ userId: admin.id, newEmail: 'root@testify.local' });
    expect(updated.must_change_password).toBe(true); // not cleared by other changes
    const changed = await userRepo.updateCredentials({ userId: admin.id, newPassword: 'my-own-long-passphrase' });
    expect(changed.must_change_password).toBe(false);
  });

  it('allows user creation and self-service credential changes', async () => {
    await userRepo.seedInitialAdmin({ password: 'password' });

    const newUser = await userRepo.create({
      username: 'tester_john',
      email: 'john@testify.local',
      password: 'MyPassword123!',
      global_role: 'Tester',
    });

    expect(newUser.username).toBe('tester_john');

    const authedBefore = await userRepo.verifyCredentials('tester_john', 'MyPassword123!');
    expect(authedBefore).not.toBeNull();

    // Self-service update credentials
    await userRepo.updateCredentials({
      userId: newUser.id,
      newUsername: 'john_updated',
      newPassword: 'MyNewPassword99!',
    });

    const authedAfter = await userRepo.verifyCredentials('john_updated', 'MyNewPassword99!');
    expect(authedAfter).not.toBeNull();
    expect(authedAfter?.username).toBe('john_updated');
  });

  it('enforces explicit project roles and privilege delegation', async () => {
    const lead = await userRepo.create({
      username: 'dev_lead',
      email: 'lead@testify.local',
      password: 'LeadPassword1!',
      global_role: 'Tester', // Global Tester
    });

    // Verify global permissions for Tester do NOT include USER_MANAGE or SPEC_APPROVE
    const globalPerms = await roleRepo.evaluatePermissions(lead.id);
    expect(globalPerms).toContain('EXECUTE_RUN');
    expect(globalPerms).not.toContain('USER_MANAGE');
    expect(globalPerms).not.toContain('SPEC_APPROVE');

    // Admin delegates Admin role on Project Alpha
    const projectRepo = new ProjectRepository(db);
    const project = await projectRepo.create({ name: 'Project Alpha', prefix: 'ALPHA' });
    await roleRepo.assignProjectRole(lead.id, project.id, 'Admin');

    // Evaluate effective permissions on Project Alpha (explicit project override)
    const projectPerms = await roleRepo.evaluatePermissions(lead.id, project.id);
    expect(projectPerms).toContain('SPEC_APPROVE');
    expect(projectPerms).toContain('USER_MANAGE'); // Admin holds USER_MANAGE
  });
});
