import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';

describe('Machine API tokens: definition CRUD, capability ceiling, and audit trail', () => {
  let serverInstance: any;

  beforeEach(async () => {
    serverInstance = await createServer();
  });

  afterEach(async () => {
    await serverInstance.db.destroy();
  });

  async function loginAsAdmin(app: any): Promise<{ token: string; userId: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'admin', password: 'password' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    return { token: body.token as string, userId: body.user.id as string };
  }

  async function createAndLoginAs(app: any, adminToken: string, globalRole: string): Promise<{ token: string; userId: string }> {
    const username = `${globalRole.replace(/\s+/g, '_').toLowerCase()}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { username, email: `${username}@testify.local`, password: 'SecurePass123!', global_role: globalRole },
    });
    expect(createRes.statusCode).toBe(201);
    const userId = JSON.parse(createRes.payload).user.id as string;

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password: 'SecurePass123!' },
    });
    expect(loginRes.statusCode).toBe(200);
    return { token: JSON.parse(loginRes.payload).token as string, userId };
  }

  it('every route requires API_TOKEN_MANAGE -- a Viewer gets 403 on all of them', async () => {
    const { app, seed } = serverInstance;
    const { token: adminToken } = await loginAsAdmin(app);
    const { token: viewerToken } = await createAndLoginAs(app, adminToken, 'Viewer');

    const attempts = [
      { method: 'POST', url: `/api/v1/projects/${seed.projectId}/api-tokens`, payload: { name: 'X', capabilities: ['SPEC_VIEW'] } },
      { method: 'GET', url: `/api/v1/projects/${seed.projectId}/api-tokens` },
      { method: 'DELETE', url: `/api/v1/projects/${seed.projectId}/api-tokens/nonexistent` },
    ] as const;

    for (const attempt of attempts) {
      const res = await app.inject({
        method: attempt.method,
        url: attempt.url,
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: 'payload' in attempt ? attempt.payload : undefined,
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it('an Admin can create a token with any registered capability except SYSTEM_ADMIN, which is always rejected', async () => {
    const { app, seed } = serverInstance;
    const { token } = await loginAsAdmin(app);

    const okRes = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${seed.projectId}/api-tokens`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'CI runner', capabilities: ['EXECUTE_RUN', 'SPEC_VIEW'] },
    });
    expect(okRes.statusCode).toBe(201);
    const body = JSON.parse(okRes.payload);
    expect(body.plaintext).toMatch(/^tf_ci_[0-9a-f]{64}$/);
    expect(body.token.capabilities).toEqual(['EXECUTE_RUN', 'SPEC_VIEW']);

    // Even a SYSTEM_ADMIN-holding Admin can never grant SYSTEM_ADMIN itself to a token --
    // PERMISSION_KEYS includes the literal 'SYSTEM_ADMIN' string, so a naive ceiling
    // check would otherwise let this mint a global cross-project super-admin credential.
    const sysAdminRes = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${seed.projectId}/api-tokens`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Dangerous', capabilities: ['SYSTEM_ADMIN'] },
    });
    expect(sysAdminRes.statusCode).toBe(400);
  });

  it('a Test Lead can create a token with capabilities they hold, and is rejected for one they lack', async () => {
    const { app, seed } = serverInstance;
    const { token: adminToken } = await loginAsAdmin(app);
    const { token: leadToken } = await createAndLoginAs(app, adminToken, 'Test Lead');

    // Test Lead holds SPEC_VIEW/EXECUTE_RUN but not USER_MANAGE (Admin-only).
    const okRes = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${seed.projectId}/api-tokens`,
      headers: { authorization: `Bearer ${leadToken}` },
      payload: { name: 'Lead token', capabilities: ['EXECUTE_RUN'] },
    });
    expect(okRes.statusCode).toBe(201);

    const exceededRes = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${seed.projectId}/api-tokens`,
      headers: { authorization: `Bearer ${leadToken}` },
      payload: { name: 'Over-privileged', capabilities: ['USER_MANAGE'] },
    });
    expect(exceededRes.statusCode).toBe(403);
    expect(JSON.parse(exceededRes.payload).code).toBe('CAPABILITY_CEILING_EXCEEDED');
  });

  it('rejects an unknown permission key, and requires name/capabilities', async () => {
    const { app, seed } = serverInstance;
    const { token } = await loginAsAdmin(app);

    const badKeyRes = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${seed.projectId}/api-tokens`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'X', capabilities: ['NOT_A_REAL_KEY'] },
    });
    expect(badKeyRes.statusCode).toBe(400);

    const noNameRes = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${seed.projectId}/api-tokens`,
      headers: { authorization: `Bearer ${token}` },
      payload: { capabilities: ['SPEC_VIEW'] },
    });
    expect(noNameRes.statusCode).toBe(400);

    const noCapsRes = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${seed.projectId}/api-tokens`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'X', capabilities: [] },
    });
    expect(noCapsRes.statusCode).toBe(400);
  });

  it('GET list never includes the plaintext or hash, and returns the issuer_capability_ceiling excluding SYSTEM_ADMIN', async () => {
    const { app, seed } = serverInstance;
    const { token } = await loginAsAdmin(app);

    await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${seed.projectId}/api-tokens`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'CI runner', capabilities: ['EXECUTE_RUN'] },
    });

    const listRes = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${seed.projectId}/api-tokens`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listRes.statusCode).toBe(200);
    const body = JSON.parse(listRes.payload);
    expect(body.tokens).toHaveLength(1);
    expect(body.tokens[0].plaintext).toBeUndefined();
    expect(body.tokens[0].token_hash).toBeUndefined();
    expect(body.issuer_capability_ceiling).not.toContain('SYSTEM_ADMIN');
    expect(body.issuer_capability_ceiling).toContain('EXECUTE_RUN');
  });

  it('DELETE revokes (204), the token shows as revoked (not removed) on the next GET, and a wrong-project DELETE 404s', async () => {
    const { app, seed } = serverInstance;
    const { token } = await loginAsAdmin(app);

    const createRes = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${seed.projectId}/api-tokens`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'To revoke', capabilities: ['SPEC_VIEW'] },
    });
    const tokenId = JSON.parse(createRes.payload).token.id;

    const otherProjectRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/nonexistent-project/api-tokens/${tokenId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(otherProjectRes.statusCode).toBe(404);

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${seed.projectId}/api-tokens/${tokenId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(deleteRes.statusCode).toBe(204);

    const listRes = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${seed.projectId}/api-tokens`,
      headers: { authorization: `Bearer ${token}` },
    });
    const listedToken = JSON.parse(listRes.payload).tokens.find((t: any) => t.id === tokenId);
    expect(listedToken).toBeDefined();
    expect(listedToken.is_revoked).toBe(true);
  });

  it('audit logs API_TOKEN_GENERATED and API_TOKEN_REVOKED, visible in the Security Audit Log, never containing the hash or plaintext', async () => {
    const { app, seed } = serverInstance;
    const { token } = await loginAsAdmin(app);

    const createRes = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${seed.projectId}/api-tokens`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Audited token', capabilities: ['SPEC_VIEW'] },
    });
    const created = JSON.parse(createRes.payload);
    const tokenId = created.token.id;
    const plaintext = created.plaintext;

    await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${seed.projectId}/api-tokens/${tokenId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    const auditRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit-logs',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(auditRes.statusCode).toBe(200);
    const logs = JSON.parse(auditRes.payload).audit_logs;

    const generated = logs.find((l: any) => l.action === 'API_TOKEN_GENERATED' && l.resource_id === tokenId);
    const revoked = logs.find((l: any) => l.action === 'API_TOKEN_REVOKED' && l.resource_id === tokenId);
    expect(generated).toBeDefined();
    expect(revoked).toBeDefined();
    expect(generated.diff).not.toContain(plaintext);
    expect(JSON.stringify(logs)).not.toContain(plaintext);
  });
});
