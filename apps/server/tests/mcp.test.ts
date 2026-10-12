import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';
import { ProjectRepository } from '@testify/db';

describe('MCP endpoint (POST /mcp)', () => {
  let serverInstance: any;

  beforeEach(async () => {
    serverInstance = await createServer();
  });

  afterEach(async () => {
    await serverInstance.db.destroy();
  });

  async function loginAsAdmin(app: any): Promise<string> {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } });
    return JSON.parse(res.payload).token;
  }

  async function mintToken(app: any, adminToken: string, projectId: string, capabilities = ['SPEC_VIEW', 'EXECUTE_RUN']): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/api-tokens`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'Agent', capabilities },
    });
    expect(res.statusCode).toBe(201);
    return JSON.parse(res.payload).plaintext;
  }

  let rpcId = 0;
  async function rpc(app: any, token: string | null, method: string, params: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      payload: { jsonrpc: '2.0', id: ++rpcId, method, params },
    });
    return res;
  }

  async function callTool(app: any, token: string, name: string, args: Record<string, unknown>) {
    const res = await rpc(app, token, 'tools/call', { name, arguments: args });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.error).toBeUndefined();
    return body.result as { isError?: boolean; content: Array<{ type: string; text: string }> };
  }

  it('requires authentication and only accepts POST', async () => {
    const { app } = serverInstance;
    expect((await rpc(app, null, 'tools/list')).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/mcp' })).statusCode).toBe(405);
  });

  it('initializes and lists the tools: read-only ones (reports from the catalog) and the write tools', async () => {
    const { app } = serverInstance;
    const token = await loginAsAdmin(app);

    const init = await rpc(app, token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(init.statusCode).toBe(200);
    const initBody = JSON.parse(init.payload);
    expect(initBody.result.serverInfo.name).toBe('testify');
    expect(initBody.result.instructions).toContain('report_run_summary');

    const list = JSON.parse((await rpc(app, token, 'tools/list')).payload);
    const names = list.result.tools.map((t: any) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['list_projects', 'list_plans_and_runs', 'search_cases', 'get_case', 'list_report_fields', 'report_overview', 'report_run_summary', 'report_case_history', 'report_plan_trend', 'report_test_health', 'report_breakdown'])
    );
    const runSummary = list.result.tools.find((t: any) => t.name === 'report_run_summary');
    expect(runSummary.inputSchema.required).toEqual(['project_id', 'test_run_id']);
    expect(runSummary.inputSchema.properties.compare_to.type).toEqual(['string', 'null']);
    expect(runSummary.inputSchema.properties.format.enum).toEqual(['json', 'markdown']);
    const WRITES = ['create_suite', 'create_case', 'update_case', 'update_cases', 'create_run', 'record_results', 'update_plan_cases'];
    for (const t of list.result.tools) expect([t.name, t.annotations?.readOnlyHint]).toEqual([t.name, !WRITES.includes(t.name)]);
    expect(names).toEqual(expect.arrayContaining([...WRITES, 'list_suites']));
  });

  it('an API token sees and reads only its own project; reports match the REST API', async () => {
    const { app, db, seed } = serverInstance;
    const admin = await loginAsAdmin(app);
    const other = await new ProjectRepository(db).create({ name: 'Other', prefix: 'OTH' });
    const token = await mintToken(app, admin, seed.projectId);

    await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${seed.buildId}/results/batch`,
      headers: { authorization: `Bearer ${token}` },
      payload: { results: [{ case_identifier: { external_id: 'SHOP-101' }, verdict: 'FAILED', failure_message: 'boom' }] },
    });

    const projects = JSON.parse((await callTool(app, token, 'list_projects', {})).content[0].text);
    expect(projects.projects.map((p: any) => p.id)).toEqual([seed.projectId]);

    const plans = JSON.parse((await callTool(app, token, 'list_plans_and_runs', { project_id: seed.projectId })).content[0].text);
    expect(plans.plans[0].runs[0].id).toBe(seed.buildId);

    const summary = await callTool(app, token, 'report_run_summary', { project_id: seed.projectId, test_run_id: seed.buildId });
    expect(summary.isError).toBeFalsy();
    const data = JSON.parse(summary.content[0].text);
    expect(data.summary).toMatchObject({ total: 10, failed: 1, untested: 9 });
    expect(data.failures[0]).toMatchObject({ external_id: 'SHOP-101', failure_message: 'boom' });

    const md = await callTool(app, token, 'report_run_summary', { project_id: seed.projectId, test_run_id: seed.buildId, format: 'markdown' });
    expect(md.content[0].text).toContain('## Test run');

    const denied = await callTool(app, token, 'report_overview', { project_id: other.id });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain('can only read project');

    const badParams = await callTool(app, token, 'report_test_health', { project_id: seed.projectId, test_plan_id: seed.planId, runs: 999 });
    expect(badParams.isError).toBe(true);
    expect(badParams.content[0].text).toContain('runs must be at most 50');

    const notFound = await callTool(app, token, 'report_run_summary', { project_id: seed.projectId, test_run_id: 'nope' });
    expect(notFound.isError).toBe(true);
  });

  it('finds and reads cases', async () => {
    const { app, seed } = serverInstance;
    const token = await loginAsAdmin(app);

    const found = JSON.parse((await callTool(app, token, 'search_cases', { project_id: seed.projectId, q: 'SHOP-105' })).content[0].text);
    expect(found.total_matches).toBe(1);
    expect(found.cases[0]).toMatchObject({ external_id: 'SHOP-105' });

    const c = JSON.parse((await callTool(app, token, 'get_case', { project_id: seed.projectId, test_case_id: 'shop-105' })).content[0].text);
    expect(c.external_id).toBe('SHOP-105');
    expect(c.latest_version.steps.length).toBeGreaterThan(0);

    const fields = JSON.parse((await callTool(app, token, 'list_report_fields', { project_id: seed.projectId })).content[0].text);
    expect(fields.fields.map((f: any) => f.key)).toContain('priority');
  });

  it("a user without SPEC_VIEW on the project can't read it", async () => {
    const { app, seed } = serverInstance;
    const admin = await loginAsAdmin(app);
    const roleRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/roles',
      headers: { authorization: `Bearer ${admin}` },
      payload: { name: `No Spec View ${Date.now()}`, description: null, permission_keys: ['EXECUTE_RUN'] },
    });
    const username = `nosv_${Date.now()}`;
    await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: { authorization: `Bearer ${admin}` },
      payload: { username, email: `${username}@testify.local`, password: 'SecurePass123!', global_role: JSON.parse(roleRes.payload).role.name },
    });
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password: 'SecurePass123!' } });
    const token = JSON.parse(login.payload).token;

    const projects = JSON.parse((await callTool(app, token, 'list_projects', {})).content[0].text);
    expect(projects.projects).toEqual([]);
    const denied = await callTool(app, token, 'report_overview', { project_id: seed.projectId });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain('SPEC_VIEW');
  });
});
