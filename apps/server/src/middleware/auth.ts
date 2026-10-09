import type { FastifyRequest, FastifyReply } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database } from '@testify/db';
import { UserRepository, RoleRepository, ApiTokenRepository, SessionRepository, API_TOKEN_PREFIX, hashToken } from '@testify/db';
import { verifyJwt } from '@testify/core';
import {
  sendInvalidTokenError,
  sendTokenRevokedError,
  sendTokenExpiredError,
  sendTokenProjectMismatchError,
  sendTokenIssuerInactiveError,
} from '../errors.js';

export interface AuthenticatedUser {
  id: string;
  username: string;
  email: string;
  global_role: string;
  permissions: string[];
  /** The user must choose a new password; until then only the routes in
   * PASSWORD_CHANGE_ALLOWED_ROUTES work. Never set for API tokens. */
  must_change_password?: boolean;
  /** The sign-in this request belongs to (see SessionRepository). Absent for API tokens. */
  session_id?: string;
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
 * The project a request acts on, so that API-token project binding and per-project role
 * assignments/overrides apply to every route -- not only those nested under
 * /projects/:projectId.
 *
 * - An explicit project (`:projectId`, `?project_id`, or an import's `target_project_id` in the
 *   query or JSON body) wins. Routes nested under a project already check that their other ids
 *   belong to it.
 * - Otherwise it's derived from the resource ids the route names (`:planId`, `:buildId`,
 *   `:caseId`, `:suiteId`, and `build_id`/`plan_id` in the query or JSON body). If those
 *   belong to different projects the request is refused.
 *
 * Returns undefined when the request names no project at all (e.g. GET /api/v1/projects), and
 * ids that don't exist are ignored (the route answers 404 for them).
 */
export type ResolvedProject = { projectId: string | null } | { conflict: string[] };

export async function resolveRequestProject(request: FastifyRequest, db: Kysely<Database>): Promise<ResolvedProject> {
  const params = (request.params as Record<string, string | undefined>) || {};
  const query = (request.query as Record<string, string | undefined>) || {};
  const body = request.body && typeof request.body === 'object' ? (request.body as Record<string, unknown>) : {};
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

  const explicit = params.projectId || query.project_id || query.target_project_id || str(body.target_project_id) || str(body.project_id);
  if (explicit) return { projectId: explicit };

  const found = new Set<string>();
  const add = (row: { project_id: string } | undefined) => row && found.add(row.project_id);
  const planId = params.planId || query.plan_id || str(body.plan_id);
  const buildId = params.buildId || query.build_id || str(body.build_id);
  if (planId) add(await db.selectFrom('test_plans').select('project_id').where('id', '=', planId).executeTakeFirst());
  if (buildId) {
    add(
      await db
        .selectFrom('builds')
        .innerJoin('test_plans', 'test_plans.id', 'builds.test_plan_id')
        .select('test_plans.project_id')
        .where('builds.id', '=', buildId)
        .executeTakeFirst()
    );
  }
  if (params.caseId) add(await db.selectFrom('test_cases').select('project_id').where('id', '=', params.caseId).executeTakeFirst());
  if (params.suiteId) add(await db.selectFrom('test_suites').select('project_id').where('id', '=', params.suiteId).executeTakeFirst());

  if (found.size > 1) return { conflict: [...found] };
  return { projectId: found.size === 1 ? [...found][0] : null };
}

/** Whether the caller holds one of `anyOf` on a project (default SPEC_VIEW), or SYSTEM_ADMIN.
 * An API token only ever sees its own project. */
export async function canViewProject(
  user: AuthenticatedUser,
  projectId: string,
  db: Kysely<Database>,
  anyOf: string[] = ['SPEC_VIEW']
): Promise<boolean> {
  if (user.api_token) return user.api_token.project_id === projectId && anyOf.some((k) => user.permissions.includes(k));
  const permissions = await new RoleRepository(db).evaluatePermissions(user.id, projectId);
  return anyOf.some((k) => permissions.includes(k)) || permissions.includes('SYSTEM_ADMIN');
}

/** A caller's permissions within one project: an API token's are fixed; a user's are
 * re-evaluated so their per-project role and overrides apply. */
export async function permissionsInProject(user: AuthenticatedUser, projectId: string, db: Kysely<Database>): Promise<string[]> {
  if (user.api_token) return user.permissions;
  return new RoleRepository(db).evaluatePermissions(user.id, projectId);
}

/**
 * An API token works only while the person who issued it still could issue it: their account is
 * active and they still manage API tokens (API_TOKEN_MANAGE, or SYSTEM_ADMIN) on the token's
 * project. It can then do only what both the token and its issuer are allowed to do, so demoting
 * the issuer narrows or stops their tokens at once. Checked on every use.
 */
export type ApiTokenIssuerAccess =
  | { active: true; capabilities: string[] }
  | { active: false; reason: 'ISSUER_DISABLED' | 'ISSUER_LOST_ACCESS' };

export async function apiTokenIssuerAccess(
  token: { created_by: string; project_id: string; capabilities: string[] },
  db: Kysely<Database>
): Promise<ApiTokenIssuerAccess> {
  const issuer = await new UserRepository(db).findById(token.created_by);
  if (!issuer || issuer.status !== 'ACTIVE') return { active: false, reason: 'ISSUER_DISABLED' };
  const held = new Set(await new RoleRepository(db).evaluatePermissions(issuer.id, token.project_id));
  if (!held.has('API_TOKEN_MANAGE') && !held.has('SYSTEM_ADMIN')) return { active: false, reason: 'ISSUER_LOST_ACCESS' };
  return { active: true, capabilities: token.capabilities.filter((c) => held.has(c)) };
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
  db: Kysely<Database>,
  requestedProjectId: string | null
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

  // A token belongs to one project. Refuse a token aimed at any other project here, once,
  // rather than relying on each route to remember to check (see resolveRequestProject).
  if (requestedProjectId && requestedProjectId !== token.project_id) {
    sendTokenProjectMismatchError(reply, token.project_id, requestedProjectId, request.url);
    return null;
  }

  const issuerAccess = await apiTokenIssuerAccess(token, db);
  if (!issuerAccess.active) {
    sendTokenIssuerInactiveError(reply, issuerAccess.reason, request.url);
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
    permissions: issuerAccess.capabilities,
    api_token: { id: token.id, project_id: token.project_id },
  };

  request.user = authUser;
  return authUser;
}

/** What a user who must change their password can still reach: who am I, change it, sign out. */
const PASSWORD_CHANGE_ALLOWED_ROUTES = new Set(['/api/v1/auth/me', '/api/v1/auth/credentials']);

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

  const resolved = await resolveRequestProject(request, db);
  if ('conflict' in resolved) {
    reply.status(400).send({
      error: 'The ids in this request belong to different projects.',
      code: 'PROJECTS_DIFFER',
      project_ids: resolved.conflict,
    });
    return null;
  }
  const projectId = resolved.projectId;

  if (token.startsWith(API_TOKEN_PREFIX)) {
    return authenticateApiToken(token, request, reply, db, projectId);
  }

  const result = verifyJwt(token, jwtSecret);
  if (!result.valid || !result.payload) {
    reply.status(401).send({ error: `Unauthorized: ${result.reason || 'invalid token'}` });
    return null;
  }

  const userId = result.payload.sub;

  // Every login token names its server-side session; signing out or changing your password
  // ends sessions, so a copied token stops working then rather than when it expires.
  const sessionId = typeof result.payload.sid === 'string' ? result.payload.sid : null;
  if (!sessionId || !(await new SessionRepository(db).findActive(sessionId, userId))) {
    reply.status(401).send({ error: 'Unauthorized: this session has ended -- please sign in again' });
    return null;
  }

  const user = await userRepo.findById(userId);
  if (!user || user.status === 'DISABLED') {
    reply.status(401).send({ error: 'Unauthorized: User account is invalid or disabled' });
    return null;
  }

  if (user.must_change_password && !PASSWORD_CHANGE_ALLOWED_ROUTES.has(request.url.split('?')[0])) {
    reply.status(403).send({ error: 'You must choose a new password before continuing.', code: 'PASSWORD_CHANGE_REQUIRED' });
    return null;
  }

  const globalRole = await roleRepo.getUserGlobalRole(user.id);
  const permissions = await roleRepo.evaluatePermissions(user.id, projectId);

  const authUser: AuthenticatedUser = {
    id: user.id,
    username: user.username,
    email: user.email,
    global_role: globalRole,
    permissions,
    must_change_password: user.must_change_password,
    session_id: sessionId,
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

/** Like requirePermission, but any one of `permissionKeys` is enough (or SYSTEM_ADMIN). */
export function requireAnyPermission(permissionKeys: string[], db: Kysely<Database>, jwtSecret: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = await authenticateRequest(request, reply, db, jwtSecret);
    if (!user) return;
    if (!permissionKeys.some((k) => user.permissions.includes(k)) && !user.permissions.includes('SYSTEM_ADMIN')) {
      return reply.status(403).send({ error: 'Forbidden: Insufficient privileges', requiredPermission: permissionKeys.join(' or ') });
    }
  };
}

/** Reads that executing tests needs (which project/plan/run you're in, the queue): viewing the
 * spec or recording results is enough. */
export const EXECUTION_READ_PERMISSIONS = ['SPEC_VIEW', 'EXECUTE_RUN'];
