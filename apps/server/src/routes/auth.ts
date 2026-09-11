import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database } from '@testify/db';
import { UserRepository, RoleRepository } from '@testify/db';
import { signJwt } from '@testify/core';
import { authenticateRequest } from '../middleware/auth.js';

export async function registerAuthRoutes(app: FastifyInstance, db: Kysely<Database>, jwtSecret: string) {
  const userRepo = new UserRepository(db);
  const roleRepo = new RoleRepository(db);

  // POST /api/v1/auth/login
  app.post('/api/v1/auth/login', async (request, reply) => {
    const { username, email, password } = (request.body as any) || {};
    const identifier = username || email;

    if (!identifier || !password) {
      return reply.status(400).send({ error: 'Username/email and password are required' });
    }

    // Ensure initial admin is seeded on startup
    await userRepo.seedInitialAdmin();

    const user = await userRepo.verifyCredentials(identifier, password);
    if (!user) {
      return reply.status(401).send({ error: 'Invalid credentials or user account disabled' });
    }

    const globalRole = await roleRepo.getUserGlobalRole(user.id);
    const permissions = await roleRepo.evaluatePermissions(user.id);

    // Sign a real HMAC-SHA256 JWT (15 minute lifetime) -- see packages/core/src/security/jwt.ts.
    const token = signJwt({ sub: user.id, username: user.username }, jwtSecret);

    return reply.status(200).send({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        global_role: globalRole,
        permissions,
      },
    });
  });

  // POST /api/v1/auth/logout
  app.post('/api/v1/auth/logout', async (_request, reply) => {
    return reply.status(200).send({ message: 'Successfully logged out' });
  });

  // GET /api/v1/auth/me
  app.get('/api/v1/auth/me', async (request, reply) => {
    const user = await authenticateRequest(request, reply, db, jwtSecret);
    if (!user) return;

    return reply.status(200).send({ user });
  });

  // PUT /api/v1/auth/credentials - Self-service username & password update
  app.put('/api/v1/auth/credentials', async (request, reply) => {
    const activeUser = await authenticateRequest(request, reply, db, jwtSecret);
    if (!activeUser) return;

    const { newUsername, newPassword, newEmail } = (request.body as any) || {};

    if (newUsername && newUsername !== activeUser.username) {
      const globalRole = await roleRepo.getUserGlobalRole(activeUser.id);
      const permissions = await roleRepo.evaluatePermissions(activeUser.id);
      const isAdmin =
        globalRole === 'Admin' ||
        permissions.includes('SYSTEM_ADMIN') ||
        permissions.includes('USER_MANAGE');

      if (!isAdmin) {
        return reply.status(403).send({ error: 'Only administrators can change usernames.' });
      }
    }

    try {
      const updatedUser = await userRepo.updateCredentials({
        userId: activeUser.id,
        newUsername,
        newEmail,
        newPassword,
      });

      // Audit credential change
      const now = new Date().toISOString();
      await db
        .insertInto('audit_logs')
        .values({
          id: crypto.randomUUID(),
          actor_id: activeUser.id,
          actor_type: 'USER',
          action: 'CREDENTIALS_CHANGED',
          resource_type: 'user',
          resource_id: activeUser.id,
          diff: JSON.stringify({ username: updatedUser.username, email: updatedUser.email }),
          ip_address: '127.0.0.1',
          user_agent: 'TestifyAuthService',
          created_at: now,
        })
        .execute();

      const globalRole = await roleRepo.getUserGlobalRole(updatedUser.id);
      const permissions = await roleRepo.evaluatePermissions(updatedUser.id);

      return reply.status(200).send({
        user: {
          id: updatedUser.id,
          username: updatedUser.username,
          email: updatedUser.email,
          global_role: globalRole,
          permissions,
        },
      });
    } catch (err: any) {
      if (err.message?.startsWith('PASSWORD_POLICY_VIOLATION')) {
        return reply.status(400).send({ error: err.message });
      }
      return reply.status(500).send({ error: err.message || 'Failed to update credentials' });
    }
  });
}
