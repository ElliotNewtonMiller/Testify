import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { v4 as uuidv4 } from 'uuid';
import type { Database } from '@testify/db';
import { ApiTokenRepository, UserRepository } from '@testify/db';
import { PERMISSION_KEYS, TOKEN_EXCLUDED_PERMISSIONS, isTokenGrantable } from '@testify/core';
import { requirePermission, apiTokenIssuerAccess } from '../middleware/auth.js';
import { sendCapabilityCeilingExceededError, sendError } from '../errors.js';
import { requestOrigin } from '../audit.js';
import * as O from '../openapi/areas/other.js';

/**
 * Machine API token management -- create/list/revoke tokens for CI/automation callers.
 * Nested under /api/v1/projects/:projectId/api-tokens rather than a flat path: because
 * of that nesting, authenticateRequest (middleware/auth.ts) has already resolved the
 * issuing admin's project-scoped effective permissions into request.user!.permissions
 * by the time these handlers run, so no separate call to evaluatePermissions is needed
 * to compute the capability ceiling below.
 */
export async function registerApiTokenRoutes(app: FastifyInstance, db: Kysely<Database>, jwtSecret: string) {
  const tokenRepo = new ApiTokenRepository(db);

  app.post(
    '/api/v1/projects/:projectId/api-tokens',
    { schema: O.createTokenSchema, preHandler: requirePermission('API_TOKEN_MANAGE', db, jwtSecret) },
    async (request, reply) => {
      const actor = request.user!;
      const { projectId } = request.params as { projectId: string };
      const { name, capabilities, expires_at: expiresAt } = (request.body as any) || {};

      if (!name || typeof name !== 'string' || name.length < 1 || name.length > 255) {
        return sendError(reply, 400, 'name (1-255 chars) is required');
      }
      if (!Array.isArray(capabilities) || capabilities.length === 0) {
        return sendError(reply, 400, 'capabilities (non-empty array) is required');
      }
      if (expiresAt !== undefined && expiresAt !== null) {
        const parsed = new Date(expiresAt).getTime();
        if (Number.isNaN(parsed) || parsed <= Date.now()) {
          return sendError(reply, 400, 'expires_at must be a valid future date');
        }
      }

      // SYSTEM_ADMIN is unconditionally excluded from grantable capabilities, regardless
      // of the issuer's own ceiling -- PERMISSION_KEYS (which the ceiling is drawn from)
      // includes the literal string 'SYSTEM_ADMIN' itself for any SYSTEM_ADMIN-holding
      // user (see RoleRepository.evaluatePermissions), so a naive subset check would let
      // an Admin mint a token that bypasses every permission check on every route.
      // The same goes for every permission whose routes reach beyond one project
      // (TOKEN_EXCLUDED_PERMISSIONS in packages/core/src/rbac/registry.ts).
      const excluded = capabilities.filter((k: unknown) => typeof k === 'string' && !isTokenGrantable(k));
      if (excluded.length > 0) {
        return sendError(
          reply,
          400,
          `${excluded.map((k: string) => `'${k}'`).join(', ')} can never be granted to a token: API tokens work only inside their own project.`,
          {
            code: 'CAPABILITY_NOT_GRANTABLE',
            invalid_params: excluded.map((k: string) => ({ name: 'capabilities', reason: `${k} can't be given to a token: ${TOKEN_EXCLUDED_PERMISSIONS[k]}` })),
          }
        );
      }
      const unknownKeys = capabilities.filter((k: unknown) => typeof k !== 'string' || !PERMISSION_KEYS.includes(k));
      if (unknownKeys.length > 0) {
        return sendError(reply, 400, `Unknown permission key(s): ${unknownKeys.join(', ')}`);
      }

      const allowedCeiling = actor.permissions.filter(isTokenGrantable);
      if (capabilities.some((k: string) => !allowedCeiling.includes(k))) {
        return sendCapabilityCeilingExceededError(reply, capabilities, allowedCeiling, request.url);
      }

      const { token, plaintext } = await tokenRepo.create({
        project_id: projectId,
        name,
        capabilities,
        created_by: actor.id,
        expires_at: expiresAt ?? null,
      });

      const now = new Date().toISOString();
      await db
        .insertInto('audit_logs')
        .values({
          id: uuidv4(),
          actor_id: actor.id,
          actor_type: 'USER',
          action: 'API_TOKEN_GENERATED',
          resource_type: 'api_token',
          resource_id: token.id,
          project_id: projectId,
          diff: JSON.stringify({ name, capabilities, expires_at: token.expires_at, token_prefix: token.token_prefix }),
          ...requestOrigin(request),
          created_at: now,
        })
        .execute();

      return reply.status(201).send({ token, plaintext });
    }
  );

  app.get(
    '/api/v1/projects/:projectId/api-tokens',
    { schema: O.listTokensSchema, preHandler: requirePermission('API_TOKEN_MANAGE', db, jwtSecret) },
    async (request) => {
      const actor = request.user!;
      const { projectId } = request.params as { projectId: string };
      // Each token says whether it still works: it stops when its issuer is disabled or no longer
      // manages tokens here, and only keeps the abilities its issuer still has.
      const userRepo = new UserRepository(db);
      const tokens = await Promise.all(
        (await tokenRepo.listByProject(projectId)).map(async (t) => {
          const access = await apiTokenIssuerAccess(t, db);
          return {
            ...t,
            issued_by: (await userRepo.findById(t.created_by))?.username ?? null,
            issuer_active: access.active,
            inactive_reason: access.active ? null : access.reason,
            effective_capabilities: access.active ? access.capabilities : [],
          };
        })
      );
      const issuerCapabilityCeiling = actor.permissions.filter(isTokenGrantable);
      return { tokens, issuer_capability_ceiling: issuerCapabilityCeiling };
    }
  );

  app.delete(
    '/api/v1/api-tokens/:tokenId',
    { schema: O.revokeTokenSchema, preHandler: requirePermission('API_TOKEN_MANAGE', db, jwtSecret) },
    async (request, reply) => {
      const actor = request.user!;
      const { tokenId: id } = request.params as { tokenId: string };
      const projectId = request.projectId ?? '';

      const revoked = await tokenRepo.revoke(id, projectId);
      if (!revoked) {
        return sendError(reply, 404, 'API token not found in this project');
      }

      const now = new Date().toISOString();
      await db
        .insertInto('audit_logs')
        .values({
          id: uuidv4(),
          actor_id: actor.id,
          actor_type: 'USER',
          action: 'API_TOKEN_REVOKED',
          resource_type: 'api_token',
          resource_id: id,
          project_id: projectId,
          diff: '{}',
          ...requestOrigin(request),
          created_at: now,
        })
        .execute();

      return reply.status(204).send();
    }
  );
}
