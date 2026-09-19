import type { FastifyRequest, FastifyReply } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database } from '@testify/db';
import { UserRepository, RoleRepository, ApiTokenRepository, API_TOKEN_PREFIX, hashToken } from '@testify/db';
import { verifyJwt } from '@testify/core';
import { sendInvalidTokenError, sendTokenRevokedError, sendTokenExpiredError } from '../errors.js';

export interface AuthenticatedUser {
  id: string;
  username: string;
  email: string;
  global_role: string;
  permissions: string[];
  /** Present only when authenticated via a machine API token (see authenticateApiToken
   * below). Lets project-binding-sensitive routes (ingestion.ts, batchExecution.ts)
   * enforce "this token may only touch its own project." Absent for JWT-authenticated
   * human users. */
  api_token?: { id: string; project_id: string };
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}

/**
 * Authenticates a request presenting a machine API token (Authorization: Bearer
 * tf_ci_...) instead of a JWT. Produces the same AuthenticatedUser shape as the JWT path
 * so every downstream consumer (request.user!.id/.permissions/etc.) keeps working
 * unmodified regardless of which auth method was used.
 *
 * The synthetic id is deliberately never the issuing admin's own user id -- attributing
 * every CI-recorded execution/import to the human who happened to mint the token would
 * corrupt tester_id/audit_logs.actor_id with a false identity. permissions are the
 * token's own `capabilities` array, frozen at mint time (no re-evaluation against
 * RoleRepository) -- capabilities can never include 'SYSTEM_ADMIN' (enforced at mint
 * time in routes/apiTokens.ts), so requirePermission's SYSTEM_ADMIN bypass simply never
 * fires for a token, which is exactly the desired behavior.
 */
async function authenticateApiToken(
  rawToken: string,
  request: FastifyRequest,
  reply: FastifyReply,
  db: Kysely<Database>
): Promise<AuthenticatedUser | null> {
  const tokenRepo = new ApiTokenRepository(db);
  const tokenHash = hashToken(rawToken);
  const token = await tokenRepo.findByHash(tokenHash);

  if (!token) {
    sendInvalidTokenError(reply, request.url);
    return null;
  }
  if (token.is_revoked) {
    sendTokenRevokedError(reply, request.url);
    return null;
  }
  if (token.expires_at && new Date(token.expires_at).getTime() <= Date.now()) {
    sendTokenExpiredError(reply, request.url);
    return null;
  }

  try {
    await tokenRepo.touchLastUsed(token.id);
  } catch {
    // Best-effort -- a failure to record last-used must never fail the request itself.
  }

  const authUser: AuthenticatedUser = {
    // The token's own id, unprefixed -- every id column this ends up written into
    // (executions.tester_id, audit_logs.actor_id, etc.) is varchar(36), exactly one
    // uuidv7's width with zero room for a prefix (the same class of bug this repo hit
    // once already with devId()-generated fixture ids). api_token.id below is what
    // actually signals "this is a machine identity" to any code that cares.
    id: token.id,
    username: token.name,
    email: '',
    global_role: 'ServiceAccount',
    permissions: token.capabilities,
    api_token: { id: token.id, project_id: token.project_id },
  };

  request.user = authUser;
  return authUser;
}

/**
 * Authenticates a request from its `Authorization: Bearer <...>` header -- either a
 * human JWT or a machine API token (tf_ci_...), dispatched by prefix.
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

  if (token.startsWith(API_TOKEN_PREFIX)) {
    return authenticateApiToken(token, request, reply, db);
  }

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
