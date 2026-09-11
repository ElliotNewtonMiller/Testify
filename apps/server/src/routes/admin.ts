import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database } from '@testlink/db';
import { UserRepository, RoleRepository, RoleName } from '@testlink/db';
import { authenticateRequest, requirePermission } from '../middleware/auth.js';

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

        return {
          id: u.id,
          username: u.username,
          email: u.email,
          status: u.status,
          global_role: globalRole,
          project_roles: projectRoles,
          permissions,
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

    try {
      const newUser = await userRepo.create({
        username,
        email,
        password,
        global_role: (global_role as RoleName) || 'Tester',
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
          user_agent: 'TestLinkAdminService',
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
      if (err.message?.startsWith('PASSWORD_POLICY_VIOLATION')) {
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
        user_agent: 'TestLinkAdminService',
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
        user_agent: 'TestLinkAdminService',
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
}
