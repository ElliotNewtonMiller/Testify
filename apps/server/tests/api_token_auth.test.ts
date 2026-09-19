import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';
import { ApiTokenRepository } from '@testify/db';

describe('Dual-mode auth dispatch: machine API tokens vs. JWTs', () => {
  let serverInstance: any;

  beforeEach(async () => {
    serverInstance = await createServer();
  });

  afterEach(async () => {
    await serverInstance.db.destroy();
  });

  async function loginAsAdmin(app: any): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'admin', password: 'password' },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.payload).token as string;
  }

  async function mintApiToken(app: any, adminToken: string, projectId: string, capabilities: string[]) {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/api-tokens`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'auth test token', capabilities },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    return { plaintext: body.plaintext as string, id: body.token.id as string };
  }

  it('a freshly minted token authenticates successfully and last_used_at updates', async () => {
    const { app, db, seed } = serverInstance;
    const adminToken = await loginAsAdmin(app);
    const { plaintext, id } = await mintApiToken(app, adminToken, seed.projectId, ['SPEC_VIEW']);

    const before = await new ApiTokenRepository(db).getById(id);
    expect(before?.last_used_at).toBeNull();

    // Use it against a route that requires only authentication, not a specific permission.
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/test-cases/${seed.caseIds[0]}/custom-field-values`,
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(res.statusCode).toBe(200);

    const after = await new ApiTokenRepository(db).getById(id);
    expect(after?.last_used_at).not.toBeNull();
  });

  it('a garbage tf_ci_-prefixed token that matches no row returns 401 INVALID_TOKEN', async () => {
    const { app, seed } = serverInstance;

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${seed.projectId}/api-tokens`,
      headers: { authorization: 'Bearer tf_ci_0000000000000000000000000000000000000000000000000000000000000000' },
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.payload).code).toBe('INVALID_TOKEN');
  });

  it('a revoked token returns 401 TOKEN_REVOKED', async () => {
    const { app, seed } = serverInstance;
    const adminToken = await loginAsAdmin(app);
    const { plaintext, id } = await mintApiToken(app, adminToken, seed.projectId, ['SPEC_VIEW']);

    await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${seed.projectId}/api-tokens/${id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/test-cases/${seed.caseIds[0]}/custom-field-values`,
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.payload).code).toBe('TOKEN_REVOKED');
  });

  it('an expired token returns 401 TOKEN_EXPIRED', async () => {
    const { app, db, seed } = serverInstance;
    const adminToken = await loginAsAdmin(app);
    const { plaintext, id } = await mintApiToken(app, adminToken, seed.projectId, ['SPEC_VIEW']);

    // Backdate expiry directly -- the create route validates expires_at must be in the
    // future, so an already-expired token can only be simulated by mutating the row.
    await db.updateTable('api_tokens').set({ expires_at: '2020-01-01T00:00:00.000Z' }).where('id', '=', id).execute();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/test-cases/${seed.caseIds[0]}/custom-field-values`,
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.payload).code).toBe('TOKEN_EXPIRED');
  });

  it('a malformed Bearer value that is neither a token nor a valid JWT still 401s via the existing JWT path (no regression)', async () => {
    const { app } = serverInstance;
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: { authorization: 'Bearer not.a.real.jwt' },
    });
    expect(res.statusCode).toBe(401);
  });
});
