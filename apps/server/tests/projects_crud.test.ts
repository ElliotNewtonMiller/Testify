import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';

describe('Projects: real create / edit / delete', () => {
  let serverInstance: any;

  beforeEach(async () => {
    serverInstance = await createServer();
  });

  afterEach(async () => {
    await serverInstance.db.destroy();
  });

  async function login(app: any, username = 'admin', password = 'password'): Promise<string> {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password } });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.payload).token as string;
  }

  it('creates a project (prefix normalized and validated, unique), then lists it', async () => {
    const { app } = serverInstance;
    const h = { authorization: `Bearer ${await login(app)}` };

    const created = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: h, payload: { name: '  Payments ', prefix: 'pay' } });
    expect(created.statusCode).toBe(201);
    const project = JSON.parse(created.payload).project;
    expect(project.name).toBe('Payments');
    expect(project.prefix).toBe('PAY');

    const list = JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/projects', headers: h })).payload).projects;
    expect(list.map((p: any) => p.id)).toContain(project.id);

    expect((await app.inject({ method: 'POST', url: '/api/v1/projects', headers: h, payload: { name: 'Dup', prefix: 'PAY' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/v1/projects', headers: h, payload: { name: 'Bad', prefix: '1-bad' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v1/projects', headers: h, payload: { prefix: 'NONAME' } })).statusCode).toBe(400);
  });

  it('renames a project; the prefix can only change while it has no cases', async () => {
    const { app, seed } = serverInstance;
    const h = { authorization: `Bearer ${await login(app)}` };

    const created = JSON.parse(
      (await app.inject({ method: 'POST', url: '/api/v1/projects', headers: h, payload: { name: 'Empty', prefix: 'EMP' } })).payload
    ).project;
    const renamed = await app.inject({ method: 'PUT', url: `/api/v1/projects/${created.id}`, headers: h, payload: { name: 'Renamed', prefix: 'NEW' } });
    expect(renamed.statusCode).toBe(200);
    expect(JSON.parse(renamed.payload).project).toMatchObject({ name: 'Renamed', prefix: 'NEW' });

    // The seeded sample project has cases -- its prefix is locked, its name isn't.
    expect((await app.inject({ method: 'PUT', url: `/api/v1/projects/${seed.projectId}`, headers: h, payload: { prefix: 'ZZZ' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'PUT', url: `/api/v1/projects/${seed.projectId}`, headers: h, payload: { name: 'Still fine' } })).statusCode).toBe(200);
  });

  it('deleting a project with content is blocked with counts, then force-deletes everything in it', async () => {
    const { app, seed, db } = serverInstance;
    const h = { authorization: `Bearer ${await login(app)}` };

    // Give the seeded project a recorded result so executions are in the cascade too.
    const planCase = await db.selectFrom('test_plan_cases').select('id').where('test_plan_id', '=', seed.planId).executeTakeFirstOrThrow();
    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/executions', headers: h, payload: { build_id: seed.buildId, test_plan_case_id: planCase.id, verdict: 'PASSED' } })).statusCode
    ).toBe(201);

    const blocked = await app.inject({ method: 'DELETE', url: `/api/v1/projects/${seed.projectId}`, headers: h });
    expect(blocked.statusCode).toBe(409);
    const problem = JSON.parse(blocked.payload);
    expect(problem.code).toBe('PROJECT_IN_USE');
    expect(problem.detail).toContain(`${seed.caseIds.length} test cases`);
    expect(await db.selectFrom('projects').select('id').where('id', '=', seed.projectId).executeTakeFirst()).toBeTruthy();

    const forced = await app.inject({ method: 'DELETE', url: `/api/v1/projects/${seed.projectId}?force=true`, headers: h });
    expect(forced.statusCode).toBe(204);
    for (const table of ['test_suites', 'test_cases', 'test_plans'] as const) {
      const rows = await db.selectFrom(table).select('id').where('project_id', '=', seed.projectId).execute();
      expect(rows).toHaveLength(0);
    }
    expect(await db.selectFrom('builds').select('id').where('id', '=', seed.buildId).executeTakeFirst()).toBeUndefined();
    expect(await db.selectFrom('projects').select('id').where('id', '=', seed.projectId).executeTakeFirst()).toBeUndefined();
    const audit = await db.selectFrom('audit_logs').selectAll().where('action', '=', 'PROJECT_DELETED').execute();
    expect(audit).toHaveLength(1);
  });

  it('an empty project deletes immediately; a Tester can neither create nor delete', async () => {
    const { app } = serverInstance;
    const adminToken = await login(app);
    const h = { authorization: `Bearer ${adminToken}` };
    const created = JSON.parse(
      (await app.inject({ method: 'POST', url: '/api/v1/projects', headers: h, payload: { name: 'Throwaway', prefix: 'TMP' } })).payload
    ).project;

    const username = `tester_${Date.now()}`;
    await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: h,
      payload: { username, email: `${username}@testify.local`, password: 'SecurePass123!', global_role: 'Tester' },
    });
    const th = { authorization: `Bearer ${await login(app, username, 'SecurePass123!')}` };
    expect((await app.inject({ method: 'POST', url: '/api/v1/projects', headers: th, payload: { name: 'X', prefix: 'X' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/projects/${created.id}`, headers: th })).statusCode).toBe(403);

    expect((await app.inject({ method: 'DELETE', url: `/api/v1/projects/${created.id}`, headers: h })).statusCode).toBe(204);
  });
});
