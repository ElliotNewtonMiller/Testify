import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Kysely } from 'kysely';
import { createDbClient } from '../src/client.js';
import type { Database } from '../src/types.js';
import * as initialSchema from '../src/migrations/001_initial_schema.js';
import { ApiTokenRepository, ProjectRepository, hashToken, API_TOKEN_PREFIX } from '../src/repositories/index.js';

describe('ApiTokenRepository', () => {
  let db: Kysely<Database>;
  let tokenRepo: ApiTokenRepository;
  let projectRepo: ProjectRepository;

  beforeEach(async () => {
    db = createDbClient();
    await initialSchema.up(db);

    tokenRepo = new ApiTokenRepository(db);
    projectRepo = new ProjectRepository(db);
  });

  afterEach(async () => {
    try {
      await initialSchema.down(db);
    } finally {
      await db.destroy();
    }
  });

  it('create() generates a tf_ci_-prefixed plaintext, an 8-hex-char display prefix, and a SHA-256 hash -- never storing the plaintext', async () => {
    const project = await projectRepo.create({ name: 'P', prefix: 'TOK' });

    const { token, plaintext } = await tokenRepo.create({
      project_id: project.id,
      name: 'CI runner',
      capabilities: ['EXECUTE_RUN'],
      created_by: 'admin_user_id',
    });

    expect(plaintext).toMatch(new RegExp(`^${API_TOKEN_PREFIX}[0-9a-f]{64}$`));
    expect(token.token_prefix).toBe(plaintext.slice(0, API_TOKEN_PREFIX.length + 8));
    expect(token.capabilities).toEqual(['EXECUTE_RUN']);
    expect(token.is_revoked).toBe(false);

    const raw = await db.selectFrom('api_tokens').selectAll().where('id', '=', token.id).executeTakeFirstOrThrow();
    expect(raw.token_hash).toBe(hashToken(plaintext));
    expect(raw.token_hash).not.toContain(plaintext);
    expect(JSON.stringify(raw)).not.toContain(plaintext);
  });

  it('findByHash finds an exact match and returns undefined for an unrelated hash', async () => {
    const project = await projectRepo.create({ name: 'P', prefix: 'FBH' });
    const { token, plaintext } = await tokenRepo.create({
      project_id: project.id,
      name: 'X',
      capabilities: ['SPEC_VIEW'],
      created_by: 'u1',
    });

    const found = await tokenRepo.findByHash(hashToken(plaintext));
    expect(found?.id).toBe(token.id);

    const notFound = await tokenRepo.findByHash(hashToken('tf_ci_some_other_token'));
    expect(notFound).toBeUndefined();
  });

  it('listByProject never selects token_hash, includes revoked tokens, and is scoped per project', async () => {
    const projectA = await projectRepo.create({ name: 'A', prefix: 'LBP1' });
    const projectB = await projectRepo.create({ name: 'B', prefix: 'LBP2' });

    const { token: tokenA } = await tokenRepo.create({ project_id: projectA.id, name: 'A token', capabilities: ['SPEC_VIEW'], created_by: 'u1' });
    await tokenRepo.create({ project_id: projectB.id, name: 'B token', capabilities: ['SPEC_VIEW'], created_by: 'u1' });
    await tokenRepo.revoke(tokenA.id, projectA.id);

    const listA = await tokenRepo.listByProject(projectA.id);
    expect(listA).toHaveLength(1);
    expect(listA[0].id).toBe(tokenA.id);
    expect(listA[0].is_revoked).toBe(true);
    expect((listA[0] as any).token_hash).toBeUndefined();
  });

  it('touchLastUsed updates last_used_at', async () => {
    const project = await projectRepo.create({ name: 'P', prefix: 'TLU' });
    const { token } = await tokenRepo.create({ project_id: project.id, name: 'X', capabilities: ['SPEC_VIEW'], created_by: 'u1' });
    expect(token.last_used_at).toBeNull();

    await tokenRepo.touchLastUsed(token.id);
    const updated = await tokenRepo.getById(token.id);
    expect(updated?.last_used_at).not.toBeNull();
  });

  describe('revoke', () => {
    it('sets is_revoked and returns true when the id/project match', async () => {
      const project = await projectRepo.create({ name: 'P', prefix: 'REV1' });
      const { token } = await tokenRepo.create({ project_id: project.id, name: 'X', capabilities: ['SPEC_VIEW'], created_by: 'u1' });

      const result = await tokenRepo.revoke(token.id, project.id);
      expect(result).toBe(true);
      expect((await tokenRepo.getById(token.id))?.is_revoked).toBe(true);
    });

    it('returns false for the wrong project (no row matched)', async () => {
      const projectA = await projectRepo.create({ name: 'A', prefix: 'REV2' });
      const projectB = await projectRepo.create({ name: 'B', prefix: 'REV3' });
      const { token } = await tokenRepo.create({ project_id: projectA.id, name: 'X', capabilities: ['SPEC_VIEW'], created_by: 'u1' });

      const result = await tokenRepo.revoke(token.id, projectB.id);
      expect(result).toBe(false);
      expect((await tokenRepo.getById(token.id))?.is_revoked).toBe(false);
    });

    it('revoking an already-revoked token is a no-op, not an error', async () => {
      const project = await projectRepo.create({ name: 'P', prefix: 'REV4' });
      const { token } = await tokenRepo.create({ project_id: project.id, name: 'X', capabilities: ['SPEC_VIEW'], created_by: 'u1' });

      await tokenRepo.revoke(token.id, project.id);
      const secondResult = await tokenRepo.revoke(token.id, project.id);
      expect(secondResult).toBe(true);
      expect((await tokenRepo.getById(token.id))?.is_revoked).toBe(true);
    });

    it('returns false for a nonexistent id', async () => {
      const project = await projectRepo.create({ name: 'P', prefix: 'REV5' });
      const result = await tokenRepo.revoke('does-not-exist', project.id);
      expect(result).toBe(false);
    });
  });
});
