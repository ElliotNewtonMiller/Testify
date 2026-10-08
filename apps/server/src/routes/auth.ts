import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database } from '@testify/db';
import { UserRepository, RoleRepository, SessionRepository } from '@testify/db';
import { signJwt, verifyJwt } from '@testify/core';
import { authenticateRequest } from '../middleware/auth.js';

/** How long a sign-in lasts (the login token and its session expire together). */
const SESSION_LIFETIME_SECONDS = 60 * 60;

export async function registerAuthRoutes(app: FastifyInstance, db: Kysely<Database>, jwtSecret: string) {
  const userRepo = new UserRepository(db);
  const roleRepo = new RoleRepository(db);
  const sessionRepo = new SessionRepository(db);

  // POST /api/v1/auth/login
  app.post('/api/v1/auth/login', async (request, reply) => {
    const { username, email, password } = (request.body as any) || {};
    const identifier = username || email;

    if (!identifier || !password) {
      return reply.status(400).send({ error: 'Username/email and password are required' });
    }

    const user = await userRepo.verifyCredentials(identifier, password);
    if (!user) {
      return reply.status(401).send({ error: 'Invalid credentials or user account disabled' });
    }

    const globalRole = await roleRepo.getUserGlobalRole(user.id);
    const permissions = await roleRepo.evaluatePermissions(user.id);

    // Each sign-in gets a server-side session the token names (`sid`), so it can be ended
    // before the token expires -- see SessionRepository and authenticateRequest.
    const session = await sessionRepo.create(user.id, SESSION_LIFETIME_SECONDS);
    const token = signJwt({ sub: user.id, username: user.username, sid: session.id }, jwtSecret, SESSION_LIFETIME_SECONDS);

    return reply.status(200).send({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        global_role: globalRole,
        permissions,
        must_change_password: user.must_change_password,
      },
    });
  });

  // POST /api/v1/auth/logout -- ends the caller's session, so its token stops working. Always
  // answers 200 (signing out with a missing or already-dead token is still "signed out").
  app.post('/api/v1/auth/logout', async (request, reply) => {
    const header = request.headers['authorization'];
    const result = typeof header === 'string' && header.startsWith('Bearer ') ? verifyJwt(header.substring(7), jwtSecret) : null;
    const sessionId = result?.valid ? result.payload?.sid : undefined;
    if (typeof sessionId === 'string' && (await sessionRepo.findActive(sessionId, result!.payload!.sub))) {
      await sessionRepo.revoke(sessionId);
    }
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

    const { newUsername, newPassword, newEmail, currentPassword } = (request.body as any) || {};

    // A new password needs the current one, so a stolen session token alone can't take over
    // the account.
    if (newPassword) {
      if (!currentPassword) {
        return reply.status(400).send({ error: 'Enter your current password to set a new one.', code: 'CURRENT_PASSWORD_REQUIRED' });
      }
      if (!(await userRepo.isCurrentPassword(activeUser.id, currentPassword))) {
        return reply.status(403).send({ error: 'Your current password is incorrect.', code: 'CURRENT_PASSWORD_INCORRECT' });
      }
    }

    // A user who must change their password (e.g. the first admin's generated one) has to pick
    // a new, different one; that's the only change they can make until they do.
    if (activeUser.must_change_password) {
      if (!newPassword) {
        return reply.status(400).send({ error: 'Choose a new password before continuing.', code: 'PASSWORD_CHANGE_REQUIRED' });
      }
      if (await userRepo.isCurrentPassword(activeUser.id, newPassword)) {
        return reply.status(400).send({ error: 'The new password must be different from the current one.', code: 'PASSWORD_UNCHANGED' });
      }
    }

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

      // A new password ends every other sign-in of this account (this one stays).
      const endedSessions = newPassword ? await sessionRepo.revokeAllForUser(activeUser.id, activeUser.session_id) : 0;

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
          diff: JSON.stringify({ username: updatedUser.username, email: updatedUser.email, password_changed: !!newPassword, other_sessions_ended: endedSessions }),
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
          must_change_password: updatedUser.must_change_password,
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
