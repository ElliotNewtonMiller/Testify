import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database } from '@testify/db';
import { UserRepository, RoleRepository, SessionRepository } from '@testify/db';
import { signJwt, verifyJwt } from '@testify/core';
import { authenticateRequest } from '../middleware/auth.js';
import { clearSessionCookie, passesCsrfCheck, requestCredential, setSessionCookie } from '../sessionCookie.js';
import {
  ACCOUNT_LOCK_SECONDS,
  ACCOUNT_LOCK_THRESHOLD,
  IpFailureLimiter,
  accountLockSecondsLeft,
  describeWait,
} from '../services/loginThrottle.js';

/** How long a sign-in lasts (the login token and its session expire together). */
const SESSION_LIFETIME_SECONDS = 60 * 60;

export async function registerAuthRoutes(app: FastifyInstance, db: Kysely<Database>, jwtSecret: string) {
  const userRepo = new UserRepository(db);
  const roleRepo = new RoleRepository(db);
  const sessionRepo = new SessionRepository(db);
  const ipLimiter = new IpFailureLimiter();

  const tooManyAttempts = (reply: any, seconds: number, code: string, error: string) =>
    reply.header('Retry-After', String(seconds)).status(429).send({ error, code, retry_after_seconds: seconds });

  const accountLocked = (reply: any, seconds: number) =>
    tooManyAttempts(
      reply,
      seconds,
      'ACCOUNT_LOCKED',
      `This account is locked after too many failed sign-in attempts. Try again in ${describeWait(seconds)}, or ask an administrator to unlock it.`
    );

  /** Counts a wrong password against the account; logs it in the audit log when that locks it. */
  async function recordAccountFailure(userId: string, ip: string): Promise<void> {
    const lockedUntil = await userRepo.recordFailedLogin(userId, ACCOUNT_LOCK_THRESHOLD, ACCOUNT_LOCK_SECONDS);
    if (!lockedUntil) return;
    await db
      .insertInto('audit_logs')
      .values({
        id: crypto.randomUUID(),
        actor_id: userId,
        actor_type: 'SYSTEM',
        action: 'ACCOUNT_LOCKED',
        resource_type: 'user',
        resource_id: userId,
        diff: JSON.stringify({ locked_until: lockedUntil, reason: 'TOO_MANY_FAILED_SIGN_INS' }),
        ip_address: ip,
        user_agent: 'TestifyAuthService',
        created_at: new Date().toISOString(),
      })
      .execute();
  }

  // POST /api/v1/auth/login
  app.post('/api/v1/auth/login', async (request, reply) => {
    const { username, email, password, session: sessionMode } = (request.body as any) || {};
    const identifier = username || email;

    if (!identifier || !password) {
      return reply.status(400).send({ error: 'Username/email and password are required' });
    }
    // `session: "cookie"` (the web app): the token goes into an HttpOnly cookie and is left out
    // of the response, so page scripts never see it. Needs the same header as other
    // cookie-authenticated changes, so another site can't sign a browser into an account.
    const useCookie = sessionMode === 'cookie';
    if (useCookie && !passesCsrfCheck(request)) {
      return reply.status(403).send({
        error: 'Cookie sign-in requires the X-Testify-Client header.',
        code: 'CSRF_HEADER_MISSING',
      });
    }

    // Guessing limits (services/loginThrottle.ts): this address, then this account.
    const ip = request.ip;
    const ipWait = ipLimiter.retryAfterSeconds(ip);
    if (ipWait > 0) {
      return tooManyAttempts(
        reply,
        ipWait,
        'TOO_MANY_ATTEMPTS',
        `Too many failed sign-in attempts from your network. Try again in ${describeWait(ipWait)}.`
      );
    }
    const account = await userRepo.findByUsernameOrEmail(identifier);
    const lockWait = accountLockSecondsLeft(account?.locked_until);
    if (account && lockWait > 0) {
      ipLimiter.recordFailure(ip); // not checked against the password, but still an attempt
      return accountLocked(reply, lockWait);
    }

    const user = await userRepo.verifyCredentials(identifier, password);
    if (!user) {
      ipLimiter.recordFailure(ip);
      if (account && account.status !== 'DISABLED') await recordAccountFailure(account.id, ip);
      return reply.status(401).send({ error: 'Invalid credentials or user account disabled' });
    }
    if (user.failed_login_count > 0 || user.locked_until) await userRepo.resetLoginFailures(user.id);

    const globalRole = await roleRepo.getUserGlobalRole(user.id);
    const permissions = await roleRepo.evaluatePermissions(user.id);

    // Each sign-in gets a server-side session the token names (`sid`), so it can be ended
    // before the token expires -- see SessionRepository and authenticateRequest.
    const session = await sessionRepo.create(user.id, SESSION_LIFETIME_SECONDS);
    const token = signJwt({ sub: user.id, username: user.username, sid: session.id }, jwtSecret, SESSION_LIFETIME_SECONDS);

    if (useCookie) setSessionCookie(request, reply, token, SESSION_LIFETIME_SECONDS);
    return reply.status(200).send({
      ...(useCookie ? {} : { token }),
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

  // POST /api/v1/auth/logout -- ends the caller's session, so its token stops working, and
  // clears the web app's session cookie. Always answers 200 (signing out with a missing or
  // already-dead token is still "signed out").
  app.post('/api/v1/auth/logout', async (request, reply) => {
    const credential = requestCredential(request);
    const result = credential ? verifyJwt(credential.token, jwtSecret) : null;
    clearSessionCookie(request, reply);
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
    // Wrong guesses here count toward the same account lock as sign-in.
    if (newPassword) {
      if (!currentPassword) {
        return reply.status(400).send({ error: 'Enter your current password to set a new one.', code: 'CURRENT_PASSWORD_REQUIRED' });
      }
      const self = await userRepo.findById(activeUser.id);
      const lockWait = accountLockSecondsLeft(self?.locked_until);
      if (lockWait > 0) return accountLocked(reply, lockWait);
      if (!(await userRepo.isCurrentPassword(activeUser.id, currentPassword))) {
        await recordAccountFailure(activeUser.id, request.ip);
        return reply.status(403).send({ error: 'Your current password is incorrect.', code: 'CURRENT_PASSWORD_INCORRECT' });
      }
      if (self && self.failed_login_count > 0) await userRepo.resetLoginFailures(activeUser.id);
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
      throw err; // unexpected: the global error handler logs it and answers 500
    }
  });
}
