import type { FastifyRequest, FastifyReply } from 'fastify';
import { passesCsrfCheck, requestCredential } from '../sessionCookie.js';
import type { Kysely } from 'kysely';
import type { Database } from '@testify/db';
import { UserRepository, RoleRepository, ApiTokenRepository, SessionRepository, API_TOKEN_PREFIX, hashToken } from '@testify/db';
import { verifyJwt, isTokenGrantable } from '@testify/core';
import { sendTokenNotAllowedError, sendInvalidTokenError,
  sendTokenRevokedError,
  sendTokenExpiredError,
  sendTokenProjectMismatchError,
  sendTokenIssuerInactiveError, sendError } from '../errors.js';
import { sendRateLimitedError } from '../services/rateLimits.js';
import { isInternalRequest } from '../internalRequests.js';
import { SESSION_IDLE_SECONDS, SESSION_MAX_SECONDS } from '../sessionLifetime.js';
import { applyCaseRefs, resolveCaseRef } from '../caseRefs.js';

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
    /** The project this request acts on (see resolveRequestProject), set by authenticateRequest.
     * Null when the request names no project. */
    projectId?: string | null;
  }
}

/**
 * The project a request acts on, so that API-token project binding and per-project role
 * assignments/overrides apply to every route, whether it names the project (`/projects/{id}/...`)
 * or only an item that belongs to one (`/plans/{id}`, `/runs/{id}/results`, ...).
 *
 * The project comes from every id the request names:
 * - path params `:projectId`, `:planId`, `:runId`, `:caseId`, `:suiteId`, `:versionId`,
 *   `:scheduleId`, `:tokenId`, `:resultId`, `:webhookId`, `:deliveryId` (a case may be named by its readable id, e.g. SHOP-12);
 * - `project_id`, `test_plan_id`, `test_run_id`, `test_case_id`, `test_suite_id` in the query or
 *   JSON body.
 * They must all belong to the same project, or the request is refused (`PROJECTS_DIFFER`) -- so a
 * request can't name a project it's allowed in alongside an item from another one.
 *
 * Returns `projectId: null` when the request names no project at all (e.g. GET /api/v1/projects).
 * Ids that don't exist are ignored (the route answers 404 for them).
 */
export type ResolvedProject = { projectId: string | null } | { conflict: string[] };

export async function resolveRequestProject(request: FastifyRequest, db: Kysely<Database>, projectHint: string | null = null): Promise<ResolvedProject> {
  const params = (request.params as Record<string, string | undefined>) || {};
  const query = (request.query as Record<string, string | undefined>) || {};
  const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body) ? (request.body as Record<string, unknown>) : {};
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const pick = (param: string, field: string) => params[param] || str(query[field]) || str(body[field]);

  const found = new Set<string>();
  const add = (row: { project_id: string } | undefined) => row && found.add(row.project_id);

  const projectId = pick('projectId', 'project_id');
  if (projectId) found.add(projectId);
  const planId = pick('planId', 'test_plan_id');
  if (planId) add(await db.selectFrom('test_plans').select('project_id').where('id', '=', planId).executeTakeFirst());
  const runId = pick('runId', 'test_run_id');
  if (runId) {
    add(
      await db
        .selectFrom('test_runs')
        .innerJoin('test_plans', 'test_plans.id', 'test_runs.test_plan_id')
        .select('test_plans.project_id')
        .where('test_runs.id', '=', runId)
        .executeTakeFirst()
    );
  }
  const suiteId = pick('suiteId', 'test_suite_id');
  if (suiteId) add(await db.selectFrom('test_suites').select('project_id').where('id', '=', suiteId).executeTakeFirst());
  if (params.versionId) {
    add(
      await db
        .selectFrom('test_case_versions')
        .innerJoin('test_cases', 'test_cases.id', 'test_case_versions.test_case_id')
        .select('test_cases.project_id')
        .where('test_case_versions.id', '=', params.versionId)
        .executeTakeFirst()
    );
  }
  if (params.scheduleId) add(await db.selectFrom('report_schedules').select('project_id').where('id', '=', params.scheduleId).executeTakeFirst());
  if (params.tokenId) add(await db.selectFrom('api_tokens').select('project_id').where('id', '=', params.tokenId).executeTakeFirst());
  if (params.webhookId) add(await db.selectFrom('webhooks').select('project_id').where('id', '=', params.webhookId).executeTakeFirst());
  if (params.deliveryId) {
    add(
      await db
        .selectFrom('webhook_deliveries')
        .innerJoin('webhooks', 'webhooks.id', 'webhook_deliveries.webhook_id')
        .select('webhooks.project_id')
        .where('webhook_deliveries.id', '=', params.deliveryId)
        .executeTakeFirst()
    );
  }
  if (params.resultId) {
    add(
      await db
        .selectFrom('test_results')
        .innerJoin('test_runs', 'test_runs.id', 'test_results.test_run_id')
        .innerJoin('test_plans', 'test_plans.id', 'test_runs.test_plan_id')
        .select('test_plans.project_id')
        .where('test_results.id', '=', params.resultId)
        .executeTakeFirst()
    );
  }
  // A case id, or its readable id (SHOP-12; see caseRefs.ts). Last, so a readable id shared by
  // several projects can be settled by the project the other ids name -- or, failing that, by
  // `projectHint` (an API token's own project).
  const caseRef = pick('caseId', 'test_case_id');
  if (caseRef) {
    const resolvedCase = await resolveCaseRef(db, caseRef, found.size === 1 ? [...found][0] : projectHint);
    if ('projectId' in resolvedCase) found.add(resolvedCase.projectId);
  }

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
  // Permissions a token can never hold (TOKEN_EXCLUDED_PERMISSIONS) are dropped too, so a token
  // made before they were excluded loses them at once.
  return { active: true, capabilities: token.capabilities.filter((c) => held.has(c) && isTokenGrantable(c)) };
}

/** A route address names a project item when it has one of these parameters. */
const PROJECT_ROUTE_PARAM = /:(projectId|planId|runId|resultId|caseId|suiteId|versionId|scheduleId|tokenId|webhookId|deliveryId)\b/;
/** The routes outside any project that a token may still use: each stays within the token's project. */
const TOKEN_PROJECTLESS_ROUTES = new Set([
  'GET /api/v1/auth/me', // who am I
  'GET /api/v1/projects', // lists only the token's own project
  'POST /mcp', // every tool call checks its project
]);

/**
 * Whether an API token may use this route. A token is bound to one project, which is checked
 * against the project the request names (resolveRequestProject); a route that names none --
 * users, roles, global custom fields, email settings, creating projects, your own account --
 * reaches the whole system, so tokens are refused there unless the route is one of the few
 * that stay within the token's project anyway. Deny by default, so a new system-wide route
 * is safe without anyone remembering to list it.
 */
export function tokenMayUseRoute(method: string, routeUrl: string): boolean {
  return PROJECT_ROUTE_PARAM.test(routeUrl) || TOKEN_PROJECTLESS_ROUTES.has(`${method} ${routeUrl}`);
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
 * token's own `capabilities`, intersected with its issuer's current permissions in the
 * project and never including the permissions in TOKEN_EXCLUDED_PERMISSIONS (SYSTEM_ADMIN among
 * them), so requirePermission's SYSTEM_ADMIN bypass never fires for a token.
 */
/** Requests already counted against their API token's rate limit. */
const rateCountedRequests = new WeakSet<FastifyRequest>();

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

  // Every request made with a token counts against that token's allowance
  // (services/rateLimits.ts) -- once, even when a route authenticates twice (imports do).
  const limiter = request.server.rateLimits?.apiToken;
  // A request the server makes to itself for a bulk change or an MCP tool was counted as the
  // caller's one request already (internalRequests.ts).
  if (limiter && !rateCountedRequests.has(request) && !isInternalRequest(request)) {
    rateCountedRequests.add(request);
    const limited = limiter.take(`token:${token.id}`);
    if (!limited.allowed) {
      sendRateLimitedError(reply, 'requests with this API token', limiter, limited.retryAfterSeconds, request.url);
      return null;
    }
  }

  // A token belongs to one project. Refuse a token aimed at any other project here, once,
  // rather than relying on each route to remember to check (see resolveRequestProject).
  if (requestedProjectId && requestedProjectId !== token.project_id) {
    sendTokenProjectMismatchError(reply, token.project_id, requestedProjectId, request.url);
    return null;
  }

  // ...and only to routes inside a project (tokenMayUseRoute).
  const routeUrl = request.routeOptions?.url ?? request.url.split('?')[0];
  if (!tokenMayUseRoute(request.method, routeUrl)) {
    sendTokenNotAllowedError(reply, request.url);
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
    // (test_results.tester_id, audit_logs.actor_id, etc.) is varchar(36), exactly one
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
const PASSWORD_CHANGE_ALLOWED_ROUTES = new Set(['/api/v1/auth/me']);

/**
 * Authenticates a request from its `Authorization: Bearer <...>` header -- either a
 * human JWT or a machine API token (tf_ci_...), dispatched by prefix -- or, failing that,
 * from the web app's session cookie (a JWT; see sessionCookie.ts).
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

  // The Authorization header wins; the web app's HttpOnly session cookie is the fallback
  // (see sessionCookie.ts).
  const credential = requestCredential(request);
  if (!credential) {
    sendError(reply, 401, 'Unauthorized: missing Bearer token');
    return null;
  }
  const token = credential.token;
  if (credential.viaCookie) {
    // The cookie only ever holds a sign-in token, never an API token.
    if (token.startsWith(API_TOKEN_PREFIX)) {
      sendError(reply, 401, 'Unauthorized: invalid session cookie');
      return null;
    }
    if (!passesCsrfCheck(request)) {
      sendError(reply, 403, 'This request is missing the X-Testify-Client header that cookie-based sign-ins require.', { code: 'CSRF_HEADER_MISSING' });
      return null;
    }
  }

  // An API token's own project settles a readable case id shared by several projects (caseRefs.ts).
  const projectHint = token.startsWith(API_TOKEN_PREFIX) ? ((await new ApiTokenRepository(db).findByHash(hashToken(token)))?.project_id ?? null) : null;
  const resolved = await resolveRequestProject(request, db, projectHint);
  if ('conflict' in resolved) {
    sendError(reply, 400, 'The ids in this request belong to different projects.', { code: 'PROJECTS_DIFFER', project_ids: resolved.conflict });
    return null;
  }
  const projectId = resolved.projectId;
  request.projectId = projectId;

  if (token.startsWith(API_TOKEN_PREFIX)) {
    const tokenUser = await authenticateApiToken(token, request, reply, db, projectId);
    if (!tokenUser) return null;
    return (await applyCaseRefsOrRefuse(request, reply, db, projectId ?? tokenUser.api_token!.project_id)) ? tokenUser : null;
  }

  const result = verifyJwt(token, jwtSecret);
  if (!result.valid || !result.payload) {
    // E.g. signed with another key (a server restart without JWT_SECRET) or expired. The
    // message is shown to people, so it says what to do; `reason` keeps the detail.
    sendError(reply, 401, 'Unauthorized: your sign-in has ended -- please sign in again', { code: 'SESSION_ENDED', reason: result.reason || 'invalid token' });
    return null;
  }

  const userId = result.payload.sub;

  // Every login token names its server-side session; signing out or changing your password
  // ends sessions, so a copied token stops working then rather than when it expires. A session
  // also ends after SESSION_IDLE_SECONDS unused and SESSION_MAX_SECONDS after sign-in
  // (sessionLifetime.ts); each request made with it extends it.
  const sessionRepo = new SessionRepository(db);
  const sessionId = typeof result.payload.sid === 'string' ? result.payload.sid : null;
  const session = sessionId ? await sessionRepo.findActive(sessionId, userId) : undefined;
  if (!sessionId || !session || new Date(session.created_at).getTime() + SESSION_MAX_SECONDS * 1000 <= Date.now()) {
    sendError(reply, 401, 'Unauthorized: your sign-in has ended -- please sign in again', { code: 'SESSION_ENDED' });
    return null;
  }
  try {
    await sessionRepo.extend(session, SESSION_IDLE_SECONDS, SESSION_MAX_SECONDS);
  } catch {
    // Best-effort -- failing to extend the session must never fail the request itself.
  }

  const user = await userRepo.findById(userId);
  if (!user || user.status === 'DISABLED') {
    sendError(reply, 401, 'Unauthorized: User account is invalid or disabled');
    return null;
  }

  if (user.must_change_password && !PASSWORD_CHANGE_ALLOWED_ROUTES.has(request.url.split('?')[0])) {
    sendError(reply, 403, 'You must choose a new password before continuing.', { code: 'PASSWORD_CHANGE_REQUIRED' });
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
  return (await applyCaseRefsOrRefuse(request, reply, db, projectId)) ? authUser : null;
}

/** Readable case ids → internal ids (caseRefs.ts), once the caller is known; false after refusing an ambiguous one. */
async function applyCaseRefsOrRefuse(request: FastifyRequest, reply: FastifyReply, db: Kysely<Database>, projectId: string | null): Promise<boolean> {
  const problem = await applyCaseRefs(request, db, projectId);
  if (!problem) return true;
  sendError(reply, 400, problem.detail, { code: 'AMBIGUOUS_CASE_ID', invalid_params: problem.invalid_params });
  return false;
}

/**
 * Route guard enforcing strict permission key evaluation
 */
export function requirePermission(permissionKey: string, db: Kysely<Database>, jwtSecret: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = await authenticateRequest(request, reply, db, jwtSecret);
    if (!user) return; // Reply 401 already sent

    if (!user.permissions.includes(permissionKey) && !user.permissions.includes('SYSTEM_ADMIN')) {
      return sendError(reply, 403, 'Forbidden: Insufficient privileges', { required_permission: permissionKey });
    }
  };
}

/** Like requirePermission, but any one of `permissionKeys` is enough (or SYSTEM_ADMIN). */
export function requireAnyPermission(permissionKeys: string[], db: Kysely<Database>, jwtSecret: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = await authenticateRequest(request, reply, db, jwtSecret);
    if (!user) return;
    if (!permissionKeys.some((k) => user.permissions.includes(k)) && !user.permissions.includes('SYSTEM_ADMIN')) {
      return sendError(reply, 403, 'Forbidden: Insufficient privileges', { required_permission: permissionKeys.join(' or ') });
    }
  };
}

/** Reads that executing tests needs (which project/plan/run you're in, the queue): viewing the
 * spec or recording results is enough. */
export const EXECUTION_READ_PERMISSIONS = ['SPEC_VIEW', 'EXECUTE_RUN'];
