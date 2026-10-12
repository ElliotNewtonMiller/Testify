import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';

/** A token works only while its issuer could still issue it, and only with what they still have. */
describe('API tokens are bound to their issuer', () => {
  let app: any;
  let db: any;
  let seed: any;
  let adminToken: string;
  let leadId: string;
  let ciToken: string;

  const call = (token: string, method: string, url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });
  const body = (res: any) => JSON.parse(res.payload || '{}');
  const login = async (username: string, password: string) =>
    body(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password } })).token as string;
  const read = () => call(ciToken, 'GET', `/api/v1/projects/${seed.projectId}/spec-tree`);
  const listed = async () =>
    body(await call(adminToken, 'GET', `/api/v1/projects/${seed.projectId}/api-tokens`)).tokens.find((t: any) => t.name === 'ci');

  beforeEach(async () => {
    ({ app, db, seed } = await createServer());
    adminToken = await login('admin', 'password');
    const created = await call(adminToken, 'POST', '/api/v1/admin/users', {
      username: 'lead', email: 'lead@testify.local', password: 'Lead-Pass-1234', global_role: 'Test Lead',
    });
    leadId = body(created).user.id;
    const leadToken = await login('lead', 'Lead-Pass-1234');
    const minted = await call(leadToken, 'POST', `/api/v1/projects/${seed.projectId}/api-tokens`, {
      name: 'ci', capabilities: ['SPEC_VIEW', 'EXECUTE_RUN'],
    });
    expect(minted.statusCode).toBe(201);
    expect(body(minted).token.expires_at).toBeNull(); // no expiry unless asked for
    ciToken = body(minted).plaintext;
  });
  afterEach(async () => {
    await app.close();
  });

  it('stops when the issuer loses API token management, and resumes if they get it back', async () => {
    expect((await read()).statusCode).toBe(200);
    expect(await listed()).toMatchObject({ issued_by: 'lead', issuer_active: true, inactive_reason: null });

    await call(adminToken, 'PATCH', `/api/v1/admin/users/${leadId}/roles`, { global_role: 'Tester' });
    const stopped = await read();
    expect(stopped.statusCode).toBe(401);
    expect(body(stopped).type).toContain('TOKEN_ISSUER_INACTIVE');
    expect(await listed()).toMatchObject({ issuer_active: false, inactive_reason: 'ISSUER_LOST_ACCESS', effective_capabilities: [] });

    // A project-level deny counts too.
    await call(adminToken, 'PATCH', `/api/v1/admin/users/${leadId}/roles`, { global_role: 'Test Lead' });
    expect((await read()).statusCode).toBe(200);
    await call(adminToken, 'PUT', `/api/v1/admin/users/${leadId}/permission-overrides`, {
      project_id: seed.projectId, overrides: [{ permission_key: 'API_TOKEN_MANAGE', is_granted: false }],
    });
    expect((await read()).statusCode).toBe(401);
  });

  it("can only do what its issuer still can", async () => {
    await call(adminToken, 'PUT', `/api/v1/admin/users/${leadId}/permission-overrides`, {
      project_id: seed.projectId, overrides: [{ permission_key: 'EXECUTE_RUN', is_granted: false }],
    });
    expect((await read()).statusCode).toBe(200); // still has SPEC_VIEW
    const planCase = await db.selectFrom('test_plan_cases').select('id').where('test_plan_id', '=', seed.planId).executeTakeFirstOrThrow();
    const record = await call(ciToken, 'POST', `/api/v1/runs/${seed.buildId}/results`, { test_plan_case_id: planCase.id, verdict: 'PASSED' });
    expect(record.statusCode).toBe(403);
    expect(await listed()).toMatchObject({ issuer_active: true, capabilities: ['SPEC_VIEW', 'EXECUTE_RUN'], effective_capabilities: ['SPEC_VIEW'] });
  });

  it("disabling the issuer revokes their tokens for good", async () => {
    await call(adminToken, 'PATCH', `/api/v1/admin/users/${leadId}`, { status: 'DISABLED' });
    expect((await read()).statusCode).toBe(401);
    await call(adminToken, 'PATCH', `/api/v1/admin/users/${leadId}`, { status: 'ACTIVE' });
    const res = await read();
    expect(res.statusCode).toBe(401);
    expect(body(res).type).toContain('TOKEN_REVOKED');
    expect((await listed()).is_revoked).toBe(true);
    const audit = await db.selectFrom('audit_logs').select('diff').where('action', '=', 'USER_DISABLED').executeTakeFirst();
    expect(JSON.parse(audit.diff).api_tokens_revoked).toBe(1);
  });
});
