import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database } from '@testify/db';
import { UserRepository, RoleRepository, RoleName } from '@testify/db';
import { authenticateRequest, requirePermission } from '../middleware/auth.js';
import { sendRoleInUseError } from '../errors.js';

export async function registerAdminRoutes(app: FastifyInstance, db: Kysely<Database>, jwtSecret: string) {
  const userRepo = new UserRepository(db);
  const roleRepo = new RoleRepository(db);

  // GET /api/v1/admin/users - List all system users & assigned roles (Gated by USER_MANAGE)
  app.get('/api/v1/admin/users', { preHandler: requirePermission('USER_MANAGE', db, jwtSecret) }, async () => {
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
  app.post('/api/v1/admin/users', { preHandler: requirePermission('USER_MANAGE', db, jwtSecret) }, async (request, reply) => {
    const activeUser = request.user!;
    const { username, email, password, global_role, project_roles } = (request.body as any) || {};

    if (!username || !email || !password) {
      return reply.status(400).send({ error: 'Username, email, and password are required' });
    }

    const resolvedGlobalRole = (global_role as RoleName) || 'Tester';
    if (!(await roleRepo.roleExists(resolvedGlobalRole))) {
      return reply.status(400).send({ error: `UNKNOWN_ROLE: '${resolvedGlobalRole}' is not a valid role name` });
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
          ip_address: '127.0.0.1',
          user_agent: 'TestifyAdminService',
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
        return reply.status(400).send({ error: err.message });
      }
      return reply.status(500).send({ error: err.message || 'Failed to create user' });
    }
  });

  // PUT /api/v1/admin/users/:userId/roles - Admin updates user privileges (Gated by USER_MANAGE)
  app.put('/api/v1/admin/users/:userId/roles', { preHandler: requirePermission('USER_MANAGE', db, jwtSecret) }, async (request, reply) => {
    const activeUser = request.user!;
    const { userId } = request.params as { userId: string };
    const { global_role, project_roles } = (request.body as any) || {};

    const user = await userRepo.findById(userId);
    if (!user) {
      return reply.status(404).send({ error: 'User not found' });
    }

    try {
      if (global_role) {
        await roleRepo.assignGlobalRole(userId, global_role as RoleName);
      }

      if (project_roles && Array.isArray(project_roles)) {
        for (const pr of project_roles) {
          if (pr.project_id) {
            if (pr.role) {
              await roleRepo.assignProjectRole(userId, pr.project_id, pr.role as RoleName);
            } else {
              await roleRepo.revokeProjectRole(userId, pr.project_id);
            }
          }
        }
      }
    } catch (err: any) {
      if (err.message?.startsWith('UNKNOWN_ROLE')) {
        return reply.status(400).send({ error: err.message });
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
        ip_address: '127.0.0.1',
        user_agent: 'TestifyAdminService',
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

  // PUT /api/v1/admin/users/:userId/status - Toggle user status (ACTIVE / DISABLED)
  app.put('/api/v1/admin/users/:userId/status', { preHandler: requirePermission('USER_MANAGE', db, jwtSecret) }, async (request, reply) => {
    const activeUser = request.user!;
    const { userId } = request.params as { userId: string };
    const { status } = (request.body as { status: 'ACTIVE' | 'DISABLED' }) || {};

    if (!status || !['ACTIVE', 'DISABLED'].includes(status)) {
      return reply.status(400).send({ error: 'Status must be ACTIVE or DISABLED' });
    }

    const updatedUser = await userRepo.updateStatus(userId, status);

    const now = new Date().toISOString();
    await db
      .insertInto('audit_logs')
      .values({
        id: crypto.randomUUID(),
        actor_id: activeUser.id,
        actor_type: 'USER',
        action: status === 'DISABLED' ? 'USER_DISABLED' : 'USER_ACTIVATED',
        resource_type: 'user',
        resource_id: userId,
        diff: JSON.stringify({ status }),
        ip_address: '127.0.0.1',
        user_agent: 'TestifyAdminService',
        created_at: now,
      })
      .execute();

    return reply.status(200).send({ id: updatedUser.id, status: updatedUser.status });
  });

  // GET /api/v1/admin/audit-logs - Filtered Security Audit Log Viewer (Gated by USER_MANAGE or SYSTEM_ADMIN)
  app.get('/api/v1/admin/audit-logs', { preHandler: requirePermission('USER_MANAGE', db, jwtSecret) }, async () => {
    const securityActions = [
      'USER_CREATED',
      'USER_DISABLED',
      'USER_ACTIVATED',
      'ROLE_ASSIGNED',
      'PROJECT_ACCESS_GRANTED',
      'CREDENTIALS_CHANGED',
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
    ];

    const logs = await db
      .selectFrom('audit_logs')
      .selectAll()
      .where('action', 'in', securityActions)
      .orderBy('created_at', 'desc')
      .limit(100)
      .execute();

    return { audit_logs: logs };
  });

  // GET /api/v1/admin/permissions - The permission-key registry, for rendering toggle
  // grids grouped by module. Read-only, no audit entry.
  app.get('/api/v1/admin/permissions', { preHandler: requirePermission('USER_MANAGE', db, jwtSecret) }, async () => {
    return { permissions: roleRepo.listPermissionRegistry() };
  });

  // GET /api/v1/admin/roles - List all template roles (built-in + custom) with their bundles
  app.get('/api/v1/admin/roles', { preHandler: requirePermission('USER_MANAGE', db, jwtSecret) }, async () => {
    return { roles: await roleRepo.listRoles() };
  });

  // POST /api/v1/admin/roles - Create a new template role
  app.post('/api/v1/admin/roles', { preHandler: requirePermission('USER_MANAGE', db, jwtSecret) }, async (request, reply) => {
    const activeUser = request.user!;
    const { name, description, permission_keys } = (request.body as any) || {};

    if (!name || typeof name !== 'string' || !Array.isArray(permission_keys)) {
      return reply.status(400).send({ error: 'name (string) and permission_keys (array) are required' });
    }

    try {
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
          ip_address: '127.0.0.1',
          user_agent: 'TestifyAdminService',
          created_at: now,
        })
        .execute();

      return reply.status(201).send({ role });
    } catch (err: any) {
      if (err.message?.startsWith('UNKNOWN_PERMISSION_KEY')) {
        return reply.status(400).send({ error: err.message });
      }
      if (err.message?.startsWith('ROLE_NAME_TAKEN')) {
        return reply.status(409).send({ error: err.message });
      }
      return reply.status(500).send({ error: err.message || 'Failed to create role' });
    }
  });

  // PUT /api/v1/admin/roles/:roleId - Edit a template role's name/description/permission bundle
  app.put('/api/v1/admin/roles/:roleId', { preHandler: requirePermission('USER_MANAGE', db, jwtSecret) }, async (request, reply) => {
    const activeUser = request.user!;
    const { roleId } = request.params as { roleId: string };
    const { name, description, permission_keys } = (request.body as any) || {};

    try {
      const role = await roleRepo.updateRole(roleId, {
        name: typeof name === 'string' ? name : undefined,
        description: description !== undefined ? description : undefined,
        permission_keys: Array.isArray(permission_keys) ? permission_keys : undefined,
      });

      if (!role) {
        return reply.status(404).send({ error: 'Role not found' });
      }

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
          ip_address: '127.0.0.1',
          user_agent: 'TestifyAdminService',
          created_at: now,
        })
        .execute();

      return reply.status(200).send({ role });
    } catch (err: any) {
      if (err.message?.startsWith('UNKNOWN_PERMISSION_KEY')) {
        return reply.status(400).send({ error: err.message });
      }
      if (err.message?.startsWith('ROLE_NAME_TAKEN')) {
        return reply.status(409).send({ error: err.message });
      }
      return reply.status(500).send({ error: err.message || 'Failed to update role' });
    }
  });

  // DELETE /api/v1/admin/roles/:roleId - Delete a template role. Blocked (409) if any user
  // is currently assigned to it, globally or per-project -- is_system_role is informational
  // only and never protects a default role from deletion.
  app.delete('/api/v1/admin/roles/:roleId', { preHandler: requirePermission('USER_MANAGE', db, jwtSecret) }, async (request, reply) => {
    const activeUser = request.user!;
    const { roleId } = request.params as { roleId: string };

    const result = await roleRepo.deleteRole(roleId);
    if (!result.deleted) {
      if (result.blockedByUserCount === 0) {
        return reply.status(404).send({ error: 'Role not found' });
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
        ip_address: '127.0.0.1',
        user_agent: 'TestifyAdminService',
        created_at: now,
      })
      .execute();

    return reply.status(204).send();
  });

  // GET /api/v1/admin/users/:userId/permission-overrides?project_id=... - A user's raw
  // overrides at a given scope (global when project_id is omitted).
  app.get(
    '/api/v1/admin/users/:userId/permission-overrides',
    { preHandler: requirePermission('USER_MANAGE', db, jwtSecret) },
    async (request, reply) => {
      const { userId } = request.params as { userId: string };
      const { project_id: projectId } = request.query as { project_id?: string };

      const user = await userRepo.findById(userId);
      if (!user) {
        return reply.status(404).send({ error: 'User not found' });
      }

      const overrides = await roleRepo.getUserOverrides(userId, projectId || null);
      return { overrides };
    }
  );

  // PUT /api/v1/admin/users/:userId/permission-overrides - Replace-all set of overrides at
  // a given scope. Returns the recomputed effective permissions immediately.
  app.put(
    '/api/v1/admin/users/:userId/permission-overrides',
    { preHandler: requirePermission('USER_MANAGE', db, jwtSecret) },
    async (request, reply) => {
      const activeUser = request.user!;
      const { userId } = request.params as { userId: string };
      const { project_id: projectId, overrides } = (request.body as any) || {};

      const user = await userRepo.findById(userId);
      if (!user) {
        return reply.status(404).send({ error: 'User not found' });
      }

      if (!Array.isArray(overrides)) {
        return reply.status(400).send({ error: 'overrides must be an array of {permission_key, is_granted}' });
      }

      try {
        await roleRepo.setUserOverrides(userId, projectId || null, overrides);
      } catch (err: any) {
        if (err.message?.startsWith('UNKNOWN_PERMISSION_KEY')) {
          return reply.status(400).send({ error: err.message });
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
          ip_address: '127.0.0.1',
          user_agent: 'TestifyAdminService',
          created_at: now,
        })
        .execute();

      const updatedOverrides = await roleRepo.getUserOverrides(userId, projectId || null);
      const permissions = await roleRepo.evaluatePermissions(userId, projectId || null);

      return reply.status(200).send({ overrides: updatedOverrides, permissions });
    }
  );
}
