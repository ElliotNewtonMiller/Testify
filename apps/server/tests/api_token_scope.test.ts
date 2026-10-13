import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';
import { tokenMayUseRoute } from '../src/middleware/auth.js';
import { ApiTokenRepository } from '@testify/db';
import { TOKEN_EXCLUDED_PERMISSIONS } from '@testify/core';

/**
 * API tokens stay inside their project: they're refused on routes that reach the whole system,
 * and can't hold the permissions those routes need (docs/api_roadmap.md, "Fix first").
 */
describe('API tokens are limited to their own project', () => {
  let app: any;
  let db: any;
  let seed: any;
  let admin: string;
  let adminId: string;
  const body = (res: any) => JSON.parse(res.payload || '{}');
  const call = (token: string, method: string, url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined ? { payload } : {}) });
  const mint = async (capabilities: string[]) =>
    call(admin, 'POST', `/api/v1/projects/${seed.projectId}/api-tokens`, { name: 'ci', capabilities });

  beforeEach(async () => {
    ({ app, db, seed } = await createServer());
    const login = body(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } }));
    admin = login.token;
    adminId = login.user.id;
  });
  afterEach(async () => {
    await app.close();
  });

  it('tells routes inside a project from system-wide ones', () => {
    expect(tokenMayUseRoute('GET', '/api/v1/projects/:projectId/plans')).toBe(true);
    expect(tokenMayUseRoute('POST', '/api/v1/runs/:runId/results/batch')).toBe(true);
    expect(tokenMayUseRoute('PATCH', '/api/v1/cases/:caseId')).toBe(true);
    expect(tokenMayUseRoute('GET', '/api/v1/auth/me')).toBe(true);
    expect(tokenMayUseRoute('GET', '/api/v1/projects')).toBe(true);
    expect(tokenMayUseRoute('POST', '/mcp')).toBe(true);
    expect(tokenMayUseRoute('POST', '/api/v1/projects')).toBe(false);
    expect(tokenMayUseRoute('PATCH', '/api/v1/auth/me')).toBe(false);
    expect(tokenMayUseRoute('GET', '/api/v1/admin/users')).toBe(false);
    expect(tokenMayUseRoute('PATCH', '/api/v1/admin/users/:userId')).toBe(false);
    expect(tokenMayUseRoute('DELETE', '/api/v1/admin/custom-fields/:id')).toBe(false);
  });

  it("can't be given a system-wide permission, and the list of grantable ones leaves them out", async () => {
    expect(Object.keys(TOKEN_EXCLUDED_PERMISSIONS).sort()).toEqual(['API_TOKEN_MANAGE', 'CUSTOM_FIELD_MANAGE', 'PROJECT_CREATE', 'SYSTEM_ADMIN', 'USER_MANAGE', 'WEBHOOK_MANAGE']);
    for (const key of Object.keys(TOKEN_EXCLUDED_PERMISSIONS)) {
      const res = await mint(['SPEC_VIEW', key]);
      expect(res.statusCode, key).toBe(400);
      expect(body(res).code, key).toBe('CAPABILITY_NOT_GRANTABLE');
      expect(body(res).invalid_params[0].reason, key).toContain(`${key} can't be given to a token`);
    }
    const listed = body(await call(admin, 'GET', `/api/v1/projects/${seed.projectId}/api-tokens`));
    expect(listed.issuer_capability_ceiling).toContain('SPEC_VIEW');
    for (const key of Object.keys(TOKEN_EXCLUDED_PERMISSIONS)) expect(listed.issuer_capability_ceiling).not.toContain(key);
    expect(await db.selectFrom('api_tokens').select('id').execute()).toEqual([]);
  });

  it('is refused on every route outside a project, and changes nothing there', async () => {
    const token = body(await mint(['SPEC_VIEW', 'EXECUTE_RUN', 'PROJECT_DELETE'])).plaintext;
    const users = await db.selectFrom('users').select('id').execute();
    const refused: Array<[string, string, unknown?]> = [
      ['GET', '/api/v1/admin/users'],
      ['POST', '/api/v1/admin/users', { username: 'sneaky', email: 's@x.io', password: 'SneakyPass123!', global_role: 'No Access' }],
      ['PATCH', `/api/v1/admin/users/${adminId}`, { status: 'DISABLED' }],
      ['GET', '/api/v1/admin/audit-logs'],
      ['GET', '/api/v1/admin/roles'],
      ['GET', '/api/v1/admin/permissions'],
      ['POST', '/api/v1/admin/custom-fields', { entity_type: 'TestCase', name: 'tok_f', field_label: 'F', field_type: 'TEXT' }],
      ['GET', '/api/v1/admin/email-settings'],
      ['GET', '/api/v1/admin/last-email'],
      ['POST', '/api/v1/projects', { name: 'From a token', prefix: 'TOK' }],
      ['PATCH', '/api/v1/auth/me', { email: 'x@y.io' }],
    ];
    for (const [method, url, payload] of refused) {
      const res = await call(token, method, url, payload);
      expect([method, url, res.statusCode, body(res).code]).toEqual([method, url, 403, 'TOKEN_NOT_ALLOWED']);
    }
    expect(await db.selectFrom('users').select('id').execute()).toHaveLength(users.length);
    expect(await db.selectFrom('custom_field_definitions').select('id').execute()).toEqual([]);
    expect(await db.selectFrom('projects').select('id').execute()).toHaveLength(1);

    // Inside its project, and the few routes that stay within it, it still works.
    expect(body(await call(token, 'GET', '/api/v1/auth/me')).user.api_token.project_id).toBe(seed.projectId);
    expect(body(await call(token, 'GET', '/api/v1/projects')).projects.map((p: any) => p.id)).toEqual([seed.projectId]);
    expect((await call(token, 'GET', `/api/v1/projects/${seed.projectId}/plans`)).statusCode).toBe(200);
    const mcp = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(mcp.statusCode).toBe(200);
    // An unknown id in a project route is still "not found", not "not allowed".
    expect((await call(token, 'GET', '/api/v1/plans/00000000-0000-0000-0000-000000000000/runs')).statusCode).toBe(404);
  });

  it('an existing token holding a now-excluded permission loses it at once', async () => {
    // As if made before the exclusion: straight into the database.
    const { plaintext } = await new ApiTokenRepository(db).create({
      project_id: seed.projectId,
      name: 'old',
      capabilities: ['SPEC_VIEW', 'API_TOKEN_MANAGE', 'USER_MANAGE'],
      created_by: adminId,
      expires_at: null,
    });
    expect(body(await call(plaintext, 'GET', '/api/v1/auth/me')).user.permissions).toEqual(['SPEC_VIEW']);
    const tokens = await call(plaintext, 'GET', `/api/v1/projects/${seed.projectId}/api-tokens`);
    expect(tokens.statusCode).toBe(403);
    expect(body(tokens).required_permission).toBe('API_TOKEN_MANAGE');
    const listed = body(await call(admin, 'GET', `/api/v1/projects/${seed.projectId}/api-tokens`)).tokens[0];
    expect(listed.capabilities).toEqual(['SPEC_VIEW', 'API_TOKEN_MANAGE', 'USER_MANAGE']);
    expect(listed.effective_capabilities).toEqual(['SPEC_VIEW']);
  });
});
