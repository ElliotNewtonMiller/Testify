import type { FastifyRequest, FastifyReply } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database } from '@testlink/db';
import { UserRepository, RoleRepository } from '@testlink/db';
import { verifyJwt } from '@testlink/core';

export interface AuthenticatedUser {
  id: string;
  username: string;
  email: string;
  global_role: string;
  permissions: string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}

/**
 * Authenticates a request from its `Authorization: Bearer <jwt>` header.
 *
 * There is no other way in: no `X-User-Id` impersonation header, and no fallback to
 * an admin (or any) user when the header is missing or invalid -- both existed here
 * previously and were as serious a hole as the unsigned tokens this replaces (either
 * one let a request act as any user, including the initial admin, with zero proof of
 * identity). A request with no valid token is simply unauthenticated: this returns
 * null and the caller replies 401.
 */
export async function authenticateRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  db: Kysely<Database>,
  jwtSecret: string
): Promise<AuthenticatedUser | null> {
  const userRepo = new UserRepository(db);
  const roleRepo = new RoleRepository(db);

  const authHeader = request.headers['authorization'] as string | undefined;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.status(401).send({ error: 'Unauthorized: missing Bearer token' });
    return null;
  }

  const token = authHeader.substring(7);
  const result = verifyJwt(token, jwtSecret);
  if (!result.valid || !result.payload) {
    reply.status(401).send({ error: `Unauthorized: ${result.reason || 'invalid token'}` });
    return null;
  }

  const userId = result.payload.sub;

  const user = await userRepo.findById(userId);
  if (!user || user.status === 'DISABLED') {
    reply.status(401).send({ error: 'Unauthorized: User account is invalid or disabled' });
    return null;
  }

  const globalRole = await roleRepo.getUserGlobalRole(user.id);
  const projectId = (request.query as any)?.project_id || (request.params as any)?.projectId || null;
  const permissions = await roleRepo.evaluatePermissions(user.id, projectId);

  const authUser: AuthenticatedUser = {
    id: user.id,
    username: user.username,
    email: user.email,
    global_role: globalRole,
    permissions,
  };

  request.user = authUser;
  return authUser;
}

/**
 * Route guard enforcing strict permission key evaluation
 */
export function requirePermission(permissionKey: string, db: Kysely<Database>, jwtSecret: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = await authenticateRequest(request, reply, db, jwtSecret);
    if (!user) return; // Reply 401 already sent

    if (!user.permissions.includes(permissionKey) && !user.permissions.includes('SYSTEM_ADMIN')) {
      return reply.status(403).send({
        error: 'Forbidden: Insufficient privileges',
        requiredPermission: permissionKey,
      });
    }
  };
}
