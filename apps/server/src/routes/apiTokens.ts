import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { v4 as uuidv4 } from 'uuid';
import type { Database } from '@testify/db';
import { ApiTokenRepository } from '@testify/db';
import { PERMISSION_KEYS } from '@testify/core';
import { requirePermission } from '../middleware/auth.js';
import { sendCapabilityCeilingExceededError } from '../errors.js';

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
    { preHandler: requirePermission('API_TOKEN_MANAGE', db, jwtSecret) },
    async (request, reply) => {
      const actor = request.user!;
      const { projectId } = request.params as { projectId: string };
      const { name, capabilities, expires_at: expiresAt } = (request.body as any) || {};

      if (!name || typeof name !== 'string' || name.length < 1 || name.length > 255) {
        return reply.status(400).send({ error: 'name (1-255 chars) is required' });
      }
      if (!Array.isArray(capabilities) || capabilities.length === 0) {
        return reply.status(400).send({ error: 'capabilities (non-empty array) is required' });
      }
      if (expiresAt !== undefined && expiresAt !== null) {
        const parsed = new Date(expiresAt).getTime();
        if (Number.isNaN(parsed) || parsed <= Date.now()) {
          return reply.status(400).send({ error: 'expires_at must be a valid future date' });
        }
      }

      // SYSTEM_ADMIN is unconditionally excluded from grantable capabilities, regardless
      // of the issuer's own ceiling -- PERMISSION_KEYS (which the ceiling is drawn from)
      // includes the literal string 'SYSTEM_ADMIN' itself for any SYSTEM_ADMIN-holding
      // user (see RoleRepository.evaluatePermissions), so a naive subset check would let
      // an Admin mint a token that bypasses every permission check on every route.
      if (capabilities.includes('SYSTEM_ADMIN')) {
        return reply.status(400).send({ error: "'SYSTEM_ADMIN' can never be granted to a token" });
      }
      const unknownKeys = capabilities.filter((k: unknown) => typeof k !== 'string' || !PERMISSION_KEYS.includes(k));
      if (unknownKeys.length > 0) {
        return reply.status(400).send({ error: `Unknown permission key(s): ${unknownKeys.join(', ')}` });
      }

      const allowedCeiling = actor.permissions.filter((k) => k !== 'SYSTEM_ADMIN');
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
          ip_address: '127.0.0.1',
          user_agent: 'TestifyAdminService',
          created_at: now,
        })
        .execute();

      return reply.status(201).send({ token, plaintext });
    }
  );

  app.get(
    '/api/v1/projects/:projectId/api-tokens',
    { preHandler: requirePermission('API_TOKEN_MANAGE', db, jwtSecret) },
    async (request) => {
      const actor = request.user!;
      const { projectId } = request.params as { projectId: string };
      const tokens = await tokenRepo.listByProject(projectId);
      const issuerCapabilityCeiling = actor.permissions.filter((k) => k !== 'SYSTEM_ADMIN');
      return { tokens, issuer_capability_ceiling: issuerCapabilityCeiling };
    }
  );

  app.delete(
    '/api/v1/projects/:projectId/api-tokens/:id',
    { preHandler: requirePermission('API_TOKEN_MANAGE', db, jwtSecret) },
    async (request, reply) => {
      const actor = request.user!;
      const { projectId, id } = request.params as { projectId: string; id: string };

      const revoked = await tokenRepo.revoke(id, projectId);
      if (!revoked) {
        return reply.status(404).send({ error: 'API token not found in this project' });
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
          ip_address: '127.0.0.1',
          user_agent: 'TestifyAdminService',
          created_at: now,
        })
        .execute();

      return reply.status(204).send();
    }
  );
}
