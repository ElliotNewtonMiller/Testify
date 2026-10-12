import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database } from '@testify/db';
import { UserRepository, RoleRepository, SessionRepository, ApiTokenRepository, RoleName, decodeCursor, toPage } from '@testify/db';
import { commaList, readPage } from '../paging.js';
import { authenticateRequest, requirePermission } from '../middleware/auth.js';
import { sendRoleInUseError, sendError } from '../errors.js';
import { AdminGuard, AdminGuardError } from '../services/adminGuard.js';
import { requestOrigin } from '../audit.js';
import * as A from '../openapi/areas/admin.js';

/** Replies for a guard violation (see services/adminGuard.ts); returns false for any other error. */
function sendGuardError(reply: any, err: unknown): boolean {
  if (!(err instanceof AdminGuardError)) return false;
  sendError(reply, err.status, err.message, { code: err.code, ...err.details });
  return true;
}

export async function registerAdminRoutes(app: FastifyInstance, db: Kysely<Database>, jwtSecret: string) {
  const userRepo = new UserRepository(db);
  const roleRepo = new RoleRepository(db);
  const guard = new AdminGuard(db);

  /** You can't edit or delete a role that grants more than you have (e.g. a user manager
   * editing the Admin role). */
  async function assertRoleWithinCeiling(actor: any, role: { name: string; permission_keys: string[] }) {
    const ceiling = new Set(await guard.ceiling(actor, null));
    const beyond = role.permission_keys.filter((k) => !ceiling.has(k));
    if (beyond.length > 0) {
      throw new AdminGuardError(
        403,
        'ROLE_OUTRANKS_ACTOR',
        `You can't change the role '${role.name}': it grants permissions you don't have (${beyond.join(', ')}).`,
        { permissions: beyond }
      );
    }
  }

  // GET /api/v1/admin/users - List all system users & assigned roles (Gated by USER_MANAGE)
  app.get('/api/v1/admin/users', { schema: A.listUsersSchema, preHandler: requirePermission('USER_MANAGE', db, jwtSecret) }, async () => {
    const rawUsers = await userRepo.findAll();

    const users = await Promise.all(
      rawUsers.map(async (u) => {
        const globalRole = await roleRepo.getUserGlobalRole(u.id);
        const projectRoles = await roleRepo.getUserProjectRoles(u.id);
        const permissions = await roleRepo.evaluatePermissions(u.id);
        const overrides = await roleRepo.getUserOverrides(u.id, null);

        return {
          id: u.id,
          username: u.username,
          email: u.email,
          status: u.status,
          // Set while the account is locked after too many failed sign-ins (loginThrottle.ts).
          locked_until: u.locked_until && new Date(u.locked_until).getTime() > Date.now() ? u.locked_until : null,
          global_role: globalRole,
          project_roles: projectRoles,
          permissions,
          overrides,
          created_at: u.created_at,
        };
      })
    );

    return { users };
  });

  // POST /api/v1/admin/users - Admin provisions a new user account (Gated by USER_MANAGE)
  app.post('/api/v1/admin/users', { schema: A.createUserSchema, preHandler: requirePermission('USER_MANAGE', db, jwtSecret) }, async (request, reply) => {
    const activeUser = request.user!;
    const { username, email, password, global_role, project_roles } = (request.body as any) || {};

    if (!username || !email || !password) {
      return sendError(reply, 400, 'Username, email, and password are required');
    }

    const resolvedGlobalRole = (global_role as RoleName) || 'Tester';
    if (!(await roleRepo.roleExists(resolvedGlobalRole))) {
      return sendError(reply, 400, `UNKNOWN_ROLE: '${resolvedGlobalRole}' is not a valid role name`);
    }

    // A new user can't be given more than the person creating them has.
    try {
      await guard.assertCanGrant(activeUser, await roleRepo.getRolePermissions(resolvedGlobalRole));
      for (const pr of Array.isArray(project_roles) ? project_roles : []) {
        if (pr?.project_id && pr?.role) {
          await guard.assertCanGrant(activeUser, await roleRepo.getRolePermissions(pr.role), pr.project_id);
        }
      }
    } catch (err) {
      if (sendGuardError(reply, err)) return;
      throw err;
    }

    try {
      const newUser = await userRepo.create({
        username,
        email,
        password,
        global_role: resolvedGlobalRole,
      });

      // Assign explicit per-project roles if provided
      if (project_roles && Array.isArray(project_roles)) {
        for (const pr of project_roles) {
          if (pr.project_id && pr.role) {
            await roleRepo.assignProjectRole(newUser.id, pr.project_id, pr.role as RoleName);
          }
        }
      }

      // Log Security Audit Event
      const now = new Date().toISOString();
      await db
        .insertInto('audit_logs')
        .values({
          id: crypto.randomUUID(),
          actor_id: activeUser.id,
          actor_type: 'USER',
          action: 'USER_CREATED',
          resource_type: 'user',
          resource_id: newUser.id,
          diff: JSON.stringify({ username: newUser.username, email: newUser.email, global_role: global_role || 'Tester' }),
          ...requestOrigin(request),
          created_at: now,
        })
        .execute();

      const assignedRole = await roleRepo.getUserGlobalRole(newUser.id);
      const assignedProjectRoles = await roleRepo.getUserProjectRoles(newUser.id);
      const permissions = await roleRepo.evaluatePermissions(newUser.id);

      return reply.status(201).send({
        user: {
          id: newUser.id,
          username: newUser.username,
          email: newUser.email,
          status: newUser.status,
          global_role: assignedRole,
          project_roles: assignedProjectRoles,
          permissions,
          created_at: newUser.created_at,
        },
      });
    } catch (err: any) {
      if (err.message?.startsWith('PASSWORD_POLICY_VIOLATION') || err.message?.startsWith('UNKNOWN_ROLE')) {
        return sendError(reply, 400, err.message);
      }
      // users.username and users.email are unique; this used to answer a generic 500.
      if (err?.code === '23505') {
        return sendError(reply, 409, 'That username or email is already used by another user.', { code: 'USER_EXISTS' });
      }
      throw err; // unexpected: the global error handler logs it and answers 500
    }
  });

  // PATCH /api/v1/admin/users/:userId/roles - Admin updates user privileges (only what the body names) (Gated by USER_MANAGE)
  app.patch('/api/v1/admin/users/:userId/roles', { schema: A.updateUserRolesSchema, preHandler: requirePermission('USER_MANAGE', db, jwtSecret) }, async (request, reply) => {
    const activeUser = request.user!;
    const { userId } = request.params as { userId: string };
    const { global_role, project_roles } = (request.body as any) || {};

    const user = await userRepo.findById(userId);
    if (!user) {
      return sendError(reply, 404, 'User not found');
    }

    const projectRoleChanges = (Array.isArray(project_roles) ? project_roles : []).filter((pr: any) => pr?.project_id);
    try {
      await guard.run(
        activeUser,
        [{ userId, projectId: null }, ...projectRoleChanges.map((pr: any) => ({ userId, projectId: pr.project_id as string }))],
        async (trx) => {
          const roles = new RoleRepository(trx);
          if (global_role) {
            await roles.assignGlobalRole(userId, global_role as RoleName);
          }
          for (const pr of projectRoleChanges) {
            if (pr.role) {
              await roles.assignProjectRole(userId, pr.project_id, pr.role as RoleName);
            } else {
              await roles.revokeProjectRole(userId, pr.project_id);
            }
          }
        }
      );
    } catch (err: any) {
      if (sendGuardError(reply, err)) return;
      if (err.message?.startsWith('UNKNOWN_ROLE')) {
        return sendError(reply, 400, err.message);
      }
      throw err;
    }

    // Audit Event
    const now = new Date().toISOString();
    await db
      .insertInto('audit_logs')
      .values({
        id: crypto.randomUUID(),
        actor_id: activeUser.id,
        actor_type: 'USER',
        action: 'ROLE_ASSIGNED',
        resource_type: 'user',
        resource_id: userId,
        diff: JSON.stringify({ global_role, project_roles }),
        ...requestOrigin(request),
        created_at: now,
      })
      .execute();

    const updatedGlobalRole = await roleRepo.getUserGlobalRole(userId);
    const updatedProjectRoles = await roleRepo.getUserProjectRoles(userId);
    const permissions = await roleRepo.evaluatePermissions(userId);

    return reply.status(200).send({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        status: user.status,
        global_role: updatedGlobalRole,
        project_roles: updatedProjectRoles,
        permissions,
      },
    });
  });

  // PATCH /api/v1/admin/users/:userId - Change a user's status (ACTIVE / DISABLED)
  app.patch('/api/v1/admin/users/:userId', { schema: A.updateUserSchema, preHandler: requirePermission('USER_MANAGE', db, jwtSecret) }, async (request, reply) => {
    const activeUser = request.user!;
    const { userId } = request.params as { userId: string };
    const { status } = (request.body as { status: 'ACTIVE' | 'DISABLED' }) || {};

    if (!status || !['ACTIVE', 'DISABLED'].includes(status)) {
      return sendError(reply, 400, 'Status must be ACTIVE or DISABLED');
    }

    const target = await userRepo.findById(userId);
    if (!target) {
      return sendError(reply, 404, 'User not found');
    }
    // Setting a user Active also clears a sign-in lock -- the Admin Panel's "Unlock".
    const wasLocked = !!target.locked_until && new Date(target.locked_until).getTime() > Date.now();

    let updatedUser;
    let revokedTokens = 0;
    try {
      updatedUser = await guard.run(activeUser, [{ userId, projectId: null }], async (trx) => {
        // Disabling an account (usually offboarding) ends its sessions and revokes the API tokens
        // it issued, for good: re-enabling the account doesn't revive either. (A demotion only
        // suspends tokens -- see apiTokenIssuerAccess.)
        if (status === 'DISABLED') {
          await new SessionRepository(trx).revokeAllForUser(userId);
          revokedTokens = await new ApiTokenRepository(trx).revokeAllIssuedBy(userId);
        }
        if (status === 'ACTIVE') await new UserRepository(trx).resetLoginFailures(userId);
        return new UserRepository(trx).updateStatus(userId, status);
      });
    } catch (err) {
      if (sendGuardError(reply, err)) return;
      throw err;
    }

    const now = new Date().toISOString();
    await db
      .insertInto('audit_logs')
      .values({
        id: crypto.randomUUID(),
        actor_id: activeUser.id,
        actor_type: 'USER',
        action: status === 'DISABLED' ? 'USER_DISABLED' : wasLocked ? 'ACCOUNT_UNLOCKED' : 'USER_ACTIVATED',
        resource_type: 'user',
        resource_id: userId,
        diff: JSON.stringify(status === 'DISABLED' ? { status, api_tokens_revoked: revokedTokens } : { status }),
        ...requestOrigin(request),
        created_at: now,
      })
      .execute();

    return reply.status(200).send({ user: { id: updatedUser.id, status: updatedUser.status } });
  });

  // POST /api/v1/admin/users/:userId/reset-password -- for someone who forgot theirs. Sets a
  // temporary password (generated unless one is given, and returned once when generated) that
  // the user must change at their next sign-in, ends all of their sessions, and clears any
  // sign-in lock. Not for your own account: that's the profile form, which asks for the
  // current password. And not for someone with permissions you don't have, in any project --
  // otherwise USER_MANAGE could take over an admin's account (the guard's rank rule).
  app.post('/api/v1/admin/users/:userId/reset-password', { schema: A.resetPasswordSchema, preHandler: requirePermission('USER_MANAGE', db, jwtSecret) }, async (request, reply) => {
    const activeUser = request.user!;
    const { userId } = request.params as { userId: string };
    const { password } = ((request.body as any) || {}) as { password?: unknown };

    if (userId === activeUser.id) {
      return sendError(reply, 400, 'Change your own password from your profile instead (it asks for your current one).', { code: 'CANNOT_RESET_OWN_PASSWORD' });
    }
    if (password !== undefined && password !== null && typeof password !== 'string') {
      return sendError(reply, 400, 'password must be text', { code: 'INVALID_PASSWORD' });
    }
    const target = await userRepo.findById(userId);
    if (!target) return sendError(reply, 404, 'User not found');

    const generated = !password;
    const temporaryPassword = generated ? randomBytes(18).toString('base64url') : (password as string);

    // Every scope the user has access in: global, plus each project where they have a role
    // or permission override -- the rank rule is checked in all of them.
    const projectIds = new Set<string>();
    for (const row of await db.selectFrom('user_project_roles').select('project_id').where('user_id', '=', userId).execute()) {
      projectIds.add(row.project_id);
    }
    for (const row of await db
      .selectFrom('user_permission_overrides')
      .select('project_id')
      .where('user_id', '=', userId)
      .where('project_id', 'is not', null)
      .execute()) {
      projectIds.add(row.project_id!);
    }

    let sessionsEnded = 0;
    try {
      await guard.run(
        activeUser,
        [{ userId, projectId: null }, ...[...projectIds].map((projectId) => ({ userId, projectId }))],
        async (trx) => {
          await new UserRepository(trx).resetPassword(userId, temporaryPassword);
          sessionsEnded = await new SessionRepository(trx).revokeAllForUser(userId);
        }
      );
    } catch (err: any) {
      if (sendGuardError(reply, err)) return;
      if (typeof err?.message === 'string' && err.message.startsWith('PASSWORD_POLICY_VIOLATION: ')) {
        return sendError(reply, 400, err.message.slice('PASSWORD_POLICY_VIOLATION: '.length), { code: 'PASSWORD_POLICY_VIOLATION' });
      }
      throw err;
    }

    await db
      .insertInto('audit_logs')
      .values({
        id: crypto.randomUUID(),
        actor_id: activeUser.id,
        actor_type: 'USER',
        action: 'PASSWORD_RESET',
        resource_type: 'user',
        resource_id: userId,
        // Never the password itself.
        diff: JSON.stringify({ generated, sessions_ended: sessionsEnded, must_change_password: true }),
        ...requestOrigin(request),
        created_at: new Date().toISOString(),
      })
      .execute();

    return reply.status(200).send({
      user: { id: userId, username: target.username, must_change_password: true },
      sessions_ended: sessionsEnded,
      ...(generated ? { temporary_password: temporaryPassword } : {}),
    });
  });

  // GET /api/v1/admin/audit-logs - Filtered Security Audit Log Viewer (Gated by USER_MANAGE or SYSTEM_ADMIN)
  app.get('/api/v1/admin/audit-logs', { schema: A.auditLogSchema, preHandler: requirePermission('USER_MANAGE', db, jwtSecret) }, async (request, reply) => {
    const securityActions = [
      'USER_CREATED',
      'USER_DISABLED',
      'USER_ACTIVATED',
      'ROLE_ASSIGNED',
      'PROJECT_ACCESS_GRANTED',
      'CREDENTIALS_CHANGED',
      'PASSWORD_RESET',
      'API_TOKEN_GENERATED',
      'API_TOKEN_REVOKED',
      'PROJECT_CREATED',
      'ROLE_CREATED',
      'ROLE_UPDATED',
      'ROLE_DELETED',
      'PERMISSION_OVERRIDES_UPDATED',
      'IMPORT_EXECUTED',
      'DATA_EXPORTED',
      'REPORT_EMAILED',
      'REPORT_SCHEDULE_CREATED',
      'REPORT_SCHEDULE_UPDATED',
      'REPORT_SCHEDULE_DELETED',
      'EMAIL_SETTINGS_UPDATED',
      'PLAN_CASE_RETIRED',
      'ACCOUNT_LOCKED',
      'ACCOUNT_UNLOCKED',
    ];

    const query = request.query as { action?: string; actor_id?: string; since?: string };
    const page = readPage(request, reply, A.AUDIT_PAGE.defaultLimit);
    if (!page) return reply;
    const since = query.since ? new Date(query.since) : null;
    if (since && Number.isNaN(since.getTime())) {
      return sendError(reply, 400, 'since must be an ISO 8601 date or date-time, e.g. 2026-10-01T00:00:00Z', {
        invalid_params: [{ name: 'since', reason: 'must be an ISO 8601 date-time' }],
      });
    }

    let logsQuery = db.selectFrom('audit_logs').selectAll().where('action', 'in', commaList(query.action) ?? securityActions);
    if (query.actor_id) logsQuery = logsQuery.where('actor_id', '=', query.actor_id);
    if (since) logsQuery = logsQuery.where('created_at', '>=', since.toISOString());
    const cursor = decodeCursor(page.cursor);
    if (cursor) {
      logsQuery = logsQuery.where((eb) => eb.or([eb('created_at', '<', cursor.ts), eb.and([eb('created_at', '=', cursor.ts), eb('id', '<', cursor.id)])]));
    }
    const rows = await logsQuery.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(page.limit + 1).execute();
    const { rows: audit_logs, next_cursor } = toPage(rows, page.limit, (r) => ({ ts: String(r.created_at), id: r.id }));
    return { audit_logs, next_cursor };
  });

  // GET /api/v1/admin/permissions - The permission-key registry, for rendering toggle
  // grids grouped by module. Read-only, no audit entry.
  // Any signed-in user: it's only the list of permission names, and the API Tokens and Custom
  // Fields tabs (API_TOKEN_MANAGE / CUSTOM_FIELD_MANAGE, not USER_MANAGE) need it too.
  app.get('/api/v1/admin/permissions', { schema: A.listPermissionsSchema, preHandler: async (request, reply) => { await authenticateRequest(request, reply, db, jwtSecret); } }, async () => {
    return { permissions: roleRepo.listPermissionRegistry() };
  });

  // GET /api/v1/admin/roles - List all template roles (built-in + custom) with their bundles
  app.get('/api/v1/admin/roles', { schema: A.listRolesSchema, preHandler: requirePermission('USER_MANAGE', db, jwtSecret) }, async () => {
    return { roles: await roleRepo.listRoles() };
  });

  // POST /api/v1/admin/roles - Create a new template role
  app.post('/api/v1/admin/roles', { schema: A.createRoleSchema, preHandler: requirePermission('USER_MANAGE', db, jwtSecret) }, async (request, reply) => {
    const activeUser = request.user!;
    const { name, description, permission_keys } = (request.body as any) || {};

    if (!name || typeof name !== 'string' || !Array.isArray(permission_keys)) {
      return sendError(reply, 400, 'name (string) and permission_keys (array) are required');
    }

    try {
      await guard.assertCanGrant(activeUser, permission_keys);
      const role = await roleRepo.createRole({ name, description: description ?? null, permission_keys });

      const now = new Date().toISOString();
      await db
        .insertInto('audit_logs')
        .values({
          id: crypto.randomUUID(),
          actor_id: activeUser.id,
          actor_type: 'USER',
          action: 'ROLE_CREATED',
          resource_type: 'role',
          resource_id: role.id,
          diff: JSON.stringify({ name, description: description ?? null, permission_keys }),
          ...requestOrigin(request),
          created_at: now,
        })
        .execute();

      return reply.status(201).send({ role });
    } catch (err: any) {
      if (sendGuardError(reply, err)) return;
      if (err.message?.startsWith('UNKNOWN_PERMISSION_KEY')) {
        return sendError(reply, 400, err.message);
      }
      if (err.message?.startsWith('ROLE_NAME_TAKEN')) {
        return sendError(reply, 409, err.message);
      }
      throw err; // unexpected: the global error handler logs it and answers 500
    }
  });

  // PATCH /api/v1/admin/roles/:roleId - Edit a template role's name/description/permission bundle
  app.patch('/api/v1/admin/roles/:roleId', { schema: A.updateRoleSchema, preHandler: requirePermission('USER_MANAGE', db, jwtSecret) }, async (request, reply) => {
    const activeUser = request.user!;
    const { roleId } = request.params as { roleId: string };
    const { name, description, permission_keys } = (request.body as any) || {};

    const existing = await roleRepo.getRole(roleId);
    if (!existing) {
      return sendError(reply, 404, 'Role not found');
    }

    try {
      await assertRoleWithinCeiling(activeUser, existing);
      if (Array.isArray(permission_keys)) await guard.assertCanGrant(activeUser, permission_keys);
      // Everyone holding the role is affected: none of them may gain more than the editor has,
      // and removing SYSTEM_ADMIN from it mustn't leave the system without an admin.
      const role = await guard.run(
        activeUser,
        (trx) => new RoleRepository(trx).getRoleHolders(existing.name),
        (trx) =>
          new RoleRepository(trx).updateRole(roleId, {
            name: typeof name === 'string' ? name : undefined,
            description: description !== undefined ? description : undefined,
            permission_keys: Array.isArray(permission_keys) ? permission_keys : undefined,
          })
      );

      const now = new Date().toISOString();
      await db
        .insertInto('audit_logs')
        .values({
          id: crypto.randomUUID(),
          actor_id: activeUser.id,
          actor_type: 'USER',
          action: 'ROLE_UPDATED',
          resource_type: 'role',
          resource_id: roleId,
          diff: JSON.stringify({ name, description, permission_keys }),
          ...requestOrigin(request),
          created_at: now,
        })
        .execute();

      return reply.status(200).send({ role });
    } catch (err: any) {
      if (sendGuardError(reply, err)) return;
      if (err.message?.startsWith('UNKNOWN_PERMISSION_KEY')) {
        return sendError(reply, 400, err.message);
      }
      if (err.message?.startsWith('ROLE_NAME_TAKEN')) {
        return sendError(reply, 409, err.message);
      }
      throw err; // unexpected: the global error handler logs it and answers 500
    }
  });

  // DELETE /api/v1/admin/roles/:roleId - Delete a template role. Blocked (409) if any user
  // is currently assigned to it, globally or per-project -- is_system_role is informational
  // only and never protects a default role from deletion.
  app.delete('/api/v1/admin/roles/:roleId', { schema: A.deleteRoleSchema, preHandler: requirePermission('USER_MANAGE', db, jwtSecret) }, async (request, reply) => {
    const activeUser = request.user!;
    const { roleId } = request.params as { roleId: string };

    const existing = await roleRepo.getRole(roleId);
    if (!existing) {
      return sendError(reply, 404, 'Role not found');
    }
    try {
      await assertRoleWithinCeiling(activeUser, existing);
    } catch (err) {
      if (sendGuardError(reply, err)) return;
      throw err;
    }

    const result = await roleRepo.deleteRole(roleId);
    if (!result.deleted) {
      if (result.blockedByUserCount === 0) {
        return sendError(reply, 404, 'Role not found');
      }
      return sendRoleInUseError(reply, roleId, result.blockedByUserCount, request.url, result.roleName);
    }

    const now = new Date().toISOString();
    await db
      .insertInto('audit_logs')
      .values({
        id: crypto.randomUUID(),
        actor_id: activeUser.id,
        actor_type: 'USER',
        action: 'ROLE_DELETED',
        resource_type: 'role',
        resource_id: roleId,
        diff: JSON.stringify({}),
        ...requestOrigin(request),
        created_at: now,
      })
      .execute();

    return reply.status(204).send();
  });

  // GET /api/v1/admin/users/:userId/permission-overrides?project_id=... - A user's raw
  // overrides at a given scope (global when project_id is omitted).
  app.get(
    '/api/v1/admin/users/:userId/permission-overrides',
    { schema: A.getOverridesSchema, preHandler: requirePermission('USER_MANAGE', db, jwtSecret) },
    async (request, reply) => {
      const { userId } = request.params as { userId: string };
      const { project_id: projectId } = request.query as { project_id?: string };

      const user = await userRepo.findById(userId);
      if (!user) {
        return sendError(reply, 404, 'User not found');
      }

      const overrides = await roleRepo.getUserOverrides(userId, projectId || null);
      return { overrides };
    }
  );

  // PUT /api/v1/admin/users/:userId/permission-overrides - Replace-all set of overrides at
  // a given scope. Returns the recomputed effective permissions immediately.
  app.put(
    '/api/v1/admin/users/:userId/permission-overrides',
    { schema: A.setOverridesSchema, preHandler: requirePermission('USER_MANAGE', db, jwtSecret) },
    async (request, reply) => {
      const activeUser = request.user!;
      const { userId } = request.params as { userId: string };
      const { project_id: projectId, overrides } = (request.body as any) || {};

      const user = await userRepo.findById(userId);
      if (!user) {
        return sendError(reply, 404, 'User not found');
      }

      if (!Array.isArray(overrides)) {
        return sendError(reply, 400, 'overrides must be an array of {permission_key, is_granted}');
      }

      try {
        const scope = projectId || null;
        await guard.assertCanGrant(
          activeUser,
          overrides.filter((o: any) => o?.is_granted).map((o: any) => o.permission_key),
          scope
        );
        await guard.run(activeUser, [{ userId, projectId: scope }], (trx) =>
          new RoleRepository(trx).setUserOverrides(userId, scope, overrides)
        );
      } catch (err: any) {
        if (sendGuardError(reply, err)) return;
        if (err.message?.startsWith('UNKNOWN_PERMISSION_KEY')) {
          return sendError(reply, 400, err.message);
        }
        throw err;
      }

      const now = new Date().toISOString();
      await db
        .insertInto('audit_logs')
        .values({
          id: crypto.randomUUID(),
          actor_id: activeUser.id,
          actor_type: 'USER',
          action: 'PERMISSION_OVERRIDES_UPDATED',
          resource_type: 'user',
          resource_id: userId,
          project_id: projectId || null,
          diff: JSON.stringify({ project_id: projectId || null, overrides }),
          ...requestOrigin(request),
          created_at: now,
        })
        .execute();

      const updatedOverrides = await roleRepo.getUserOverrides(userId, projectId || null);
      const permissions = await roleRepo.evaluatePermissions(userId, projectId || null);

      return reply.status(200).send({ overrides: updatedOverrides, permissions });
    }
  );
}
