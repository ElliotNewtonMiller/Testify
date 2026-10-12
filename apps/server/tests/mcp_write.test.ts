import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';

/** MCP write tools (API roadmap step 6): agents change things as their caller, and a person approves their cases. */
describe('MCP write tools', () => {
  let app: any;
  let seed: any;
  let admin: string;
  const body = (res: any) => JSON.parse(res.payload || '{}');
  const rest = (token: string, method: string, url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined ? { payload } : {}) });
  const token = async (capabilities: string[]) => body(await rest(admin, 'POST', `/api/v1/projects/${seed.projectId}/api-tokens`, { name: 'agent', capabilities })).plaintext;

  let rpcId = 0;
  async function rpc(credential: string, method: string, params: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${credential}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'user-agent': 'claude-code/2.0' },
      payload: { jsonrpc: '2.0', id: ++rpcId, method, params },
    });
    expect(res.statusCode, res.payload).toBe(200);
    return body(res);
  }
  /** A tool's answer: the parsed JSON, or { error } for an error result. */
  async function tool(credential: string, name: string, args: Record<string, unknown>) {
    const out = (await rpc(credential, 'tools/call', { name, arguments: args })).result;
    const text = out.content[0].text;
    return out.isError ? { error: text } : JSON.parse(text);
  }

  beforeEach(async () => {
    ({ app, seed } = await createServer());
    admin = body(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } })).token;
  });
  afterEach(async () => {
    await app.close();
  });

  it('an agent writes test cases as DRAFTs, even with SPEC_AUTO_APPROVE; editing an approved case makes a new DRAFT', async () => {
    const agent = await token(['SPEC_VIEW', 'SPEC_CREATE', 'SPEC_EDIT', 'SPEC_AUTO_APPROVE', 'PLAN_MANAGE']);
    const p = seed.projectId;
    const suite = (await tool(agent, 'create_suite', { project_id: p, name: 'Checkout', parent_suite_id: seed.suiteId })).suite;
    expect((await tool(agent, 'list_suites', { project_id: p })).suites.map((s: any) => s.path)).toContain('Authentication & OAuth2 Engine / Checkout');

    const created = await tool(agent, 'create_case', {
      project_id: p,
      test_suite_id: suite.id,
      title: 'Pays with a saved card',
      priority: 'HIGH',
      steps: [{ action: 'Open checkout', expected_result: 'Saved card shown' }, { action: 'Pay' }],
    });
    expect(created).toMatchObject({ external_id: 'SHOP-1011', version: { version_number: 1, status: 'DRAFT' } });
    // Through REST, the same token's case would be approved at once.
    const viaRest = body(await rest(agent, 'POST', `/api/v1/projects/${p}/cases`, { test_suite_id: suite.id, title: 'Direct' }));
    expect(viaRest.version.status).toBe('APPROVED');

    // A DRAFT is edited in place.
    const edit = await tool(agent, 'update_case', { project_id: p, test_case_id: 'SHOP-1011', summary: 'Card on file', title: 'Pays with a stored card' });
    expect(edit).toMatchObject({ changed: ['summary', 'title'], version: { version_number: 1, status: 'DRAFT' } });
    // An APPROVED case gets a new DRAFT.
    const approvedEdit = await tool(agent, 'update_case', { project_id: p, test_case_id: 'SHOP-101', steps: [{ action: 'New step' }] });
    expect(approvedEdit.version).toEqual({ version_number: 2, status: 'DRAFT' });
    expect(approvedEdit.note).toMatch(/new DRAFT version 2/);
    const shop101 = body(await rest(admin, 'GET', '/api/v1/cases/SHOP-101/versions')).versions;
    expect(shop101.map((v: any) => v.status)).toEqual(['DRAFT', 'APPROVED']);
    expect(shop101[0].steps.map((s: any) => s.action)).toEqual(['New step']);

    // Errors come back as tool errors.
    expect((await tool(agent, 'update_case', { project_id: p, test_case_id: 'SHOP-101' })).error).toMatch(/Nothing to change/);
    expect((await tool(agent, 'create_case', { project_id: p, test_suite_id: suite.id, title: '' })).error).toMatch(/INVALID_NAME/);
    expect((await tool(agent, 'update_case', { project_id: p, test_case_id: 'SHOP-9999', title: 'x' })).error).toMatch(/not found/i);

    // Every change is marked as made through MCP, and every call is in the Security Audit Log.
    const created_rows = body(await rest(admin, 'GET', '/api/v1/admin/audit-logs?action=CASE_CREATED')).audit_logs;
    const agentRow = created_rows.find((r: any) => JSON.parse(r.diff).title === 'Pays with a saved card');
    expect([agentRow.user_agent, agentRow.actor_type]).toEqual(['claude-code/2.0 (via Testify MCP)', 'SERVICE_ACCOUNT']);
    const writes = body(await rest(admin, 'GET', '/api/v1/admin/audit-logs')).audit_logs.filter((r: any) => r.action === 'MCP_WRITE');
    expect(writes.map((r: any) => [r.resource_id, JSON.parse(r.diff).ok]).reverse()).toEqual([
      ['create_suite', true],
      ['create_case', true],
      ['update_case', true],
      ['update_case', true],
      ['update_case', false],
      ['create_case', false],
      ['update_case', false],
    ]);
  });

  it('runs and results: create a run, record results, and change many cases and a plan at once', async () => {
    const agent = await token(['SPEC_VIEW', 'SPEC_EDIT', 'RUN_MANAGE', 'EXECUTE_RUN', 'PLAN_MANAGE']);
    const p = seed.projectId;
    const run = (await tool(agent, 'create_run', { project_id: p, test_plan_id: seed.planId, name: 'Agent run' })).run;
    expect(run.status).toBe('OPEN');

    const recorded = await tool(agent, 'record_results', {
      project_id: p,
      test_run_id: run.id,
      results: [
        { test_case_id: 'SHOP-101', verdict: 'PASSED' },
        { test_case_id: seed.caseIds[1], verdict: 'FAILED', failure_message: 'timeout', notes: 'seen twice' },
        { test_case_id: 'SHOP-9999', verdict: 'PASSED' },
      ],
    });
    expect(recorded.summary).toEqual({ total: 3, recorded: 2, refused: 1 });
    expect(recorded.results.map((r: any) => [r.test_case_id, r.status])).toEqual([
      ['SHOP-101', 201],
      [seed.caseIds[1], 201],
      ['SHOP-9999', 422],
    ]);
    const results = body(await rest(admin, 'GET', `/api/v1/runs/${run.id}/results?verdict=FAILED`)).results;
    expect(results[0]).toMatchObject({ external_id: 'SHOP-102', failure_message: 'timeout', notes: 'seen twice' });

    const updated = await tool(agent, 'update_cases', { project_id: p, case_ids: ['SHOP-103', 'SHOP-104'], priority: 'LOW' });
    expect(updated.summary).toEqual({ total: 2, succeeded: 2, failed: 0 });
    expect(body(await rest(admin, 'GET', '/api/v1/cases/SHOP-104')).test_case.priority).toBe('LOW');

    const plan = body(await rest(admin, 'POST', `/api/v1/projects/${p}/plans`, { name: 'Smoke' })).plan;
    const planned = await tool(agent, 'update_plan_cases', { project_id: p, test_plan_id: plan.id, add: ['SHOP-101', 'SHOP-102'] });
    expect(planned.added.summary.succeeded).toBe(2);
    // Removing a case with results needs retire_if_has_results.
    const kept = await tool(agent, 'update_plan_cases', { project_id: p, test_plan_id: seed.planId, remove: ['SHOP-101'] });
    expect(kept.removed.results[0]).toMatchObject({ status: 409, code: 'CASE_HAS_RESULTS' });
    const retired = await tool(agent, 'update_plan_cases', { project_id: p, test_plan_id: seed.planId, remove: ['SHOP-101'], retire_if_has_results: true });
    expect(retired.removed.results[0].status).toBe(204);

    // Ids from elsewhere are refused.
    expect((await tool(agent, 'create_run', { project_id: p, test_plan_id: 'nope', name: 'x' })).error).toMatch(/not found in this project/);
  });

  it('an agent can do only what its token may: a read-only token gets no write tools', async () => {
    const reader = await token(['SPEC_VIEW']);
    const names = (await rpc(reader, 'tools/list')).result.tools.map((t: any) => t.name);
    expect(names).toContain('get_case');
    expect(names).not.toContain('create_case');
    expect((await tool(reader, 'create_case', { project_id: seed.projectId, test_suite_id: seed.suiteId, title: 'x' })).error).toMatch(/lacks SPEC_CREATE/);

    // A token that may edit but not create sees update tools, not create_case.
    const editor = await token(['SPEC_VIEW', 'SPEC_EDIT']);
    const editorTools = (await rpc(editor, 'tools/list')).result.tools.map((t: any) => t.name);
    expect(editorTools).toEqual(expect.arrayContaining(['update_case', 'update_cases']));
    expect(editorTools).not.toContain('create_case');
    // Custom fields need PLAN_MANAGE, as in REST: the error says so.
    expect((await tool(editor, 'update_cases', { project_id: seed.projectId, case_ids: ['SHOP-101'], custom_fields: { x: 1 } })).error).toMatch(/PLAN_MANAGE/);

    // A signed-in user sees every tool, and the REST rules decide.
    const tester = body(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } })).token;
    expect((await rpc(tester, 'tools/list')).result.tools.map((t: any) => t.name)).toContain('create_case');
  });
});
