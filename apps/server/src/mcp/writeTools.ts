import type { FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database } from '@testify/db';
import { TestCaseVersionRepository } from '@testify/db';
import type { AuthenticatedUser } from '../middleware/auth.js';
import { innerRequest } from '../internalRequests.js';
import { ToolError, json, type JsonSchema, type ToolDef } from './toolTypes.js';

/**
 * MCP tools that change things (API roadmap step 6). Each calls the ordinary REST routes as the
 * caller (internalRequests.ts), so an agent can do exactly what its token or user may, with the
 * same rules, errors and audit rows. On top of that:
 * - cases it creates start as DRAFT, and editing an approved case makes a new DRAFT: a person
 *   approves agents' work (there's no approve, deprecate or delete tool);
 * - its changes' audit rows say "via Testify MCP" in their User-Agent, and every call writes an
 *   MCP_WRITE row to the Security Audit Log (mcpServer.ts).
 */

const VERDICTS = ['PASSED', 'FAILED', 'BLOCKED', 'SKIPPED', 'RETEST_REQUIRED', 'KNOWN_ISSUE'];
const PRIORITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const EXECUTION_TYPES = ['MANUAL', 'AUTOMATED'];

const projectId: JsonSchema = { type: 'string', description: 'Project id (from list_projects).' };
const caseRef: JsonSchema = { type: 'string', description: 'Case id or readable id such as SHOP-12.' };
const caseRefs: JsonSchema = { type: 'array', items: caseRef, minItems: 1, maxItems: 500 };
const stepsSchema: JsonSchema = {
  type: 'array',
  maxItems: 500,
  description: 'The steps, in order. Replaces all of them.',
  items: {
    type: 'object',
    properties: { action: { type: 'string' }, expected_result: { type: 'string' } },
    required: ['action'],
    additionalProperties: false,
  },
};
const customFields: JsonSchema = {
  type: 'object',
  description: 'Custom field name or label → value (see list_report_fields for fields and options); null clears it.',
  additionalProperties: true,
};

/** A REST error as the agent's error text. */
function problem(res: { status: number; body: any }): ToolError {
  const b = res.body ?? {};
  const params = Array.isArray(b.invalid_params) && b.invalid_params.length ? ` (${b.invalid_params.map((p: any) => `${p.name} ${p.reason}`).join('; ')})` : '';
  return new ToolError(`${b.detail ?? `HTTP ${res.status}`}${b.code ? ` [${b.code}]` : ''}${params}`);
}

export interface WriteToolDeps {
  db: Kysely<Database>;
  requireProject: (user: AuthenticatedUser, projectId: unknown) => Promise<string>;
  /** The case's internal id and readable id in the project (throws when it isn't there). */
  findCase: (projectId: string, ref: string) => Promise<{ id: string; external_id: string }>;
}

export function writeTools({ db, requireProject, findCase }: WriteToolDeps): ToolDef[] {
  const versionRepo = new TestCaseVersionRepository(db);

  /** A REST call as the agent's caller; a failure becomes the tool's error. 207 (some items failed) is an answer. */
  async function call(request: FastifyRequest, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
    const res = await innerRequest(request, 'mcp', method, url, payload);
    if (res.status >= 400) throw problem(res);
    return res.body;
  }

  async function planInProject(planId: unknown, project: string): Promise<string> {
    const plan = typeof planId === 'string' ? await db.selectFrom('test_plans').select(['id', 'project_id']).where('id', '=', planId).executeTakeFirst() : undefined;
    if (!plan || plan.project_id !== project) throw new ToolError(`Test plan '${String(planId)}' not found in this project (see list_plans_and_runs).`);
    return plan.id;
  }

  async function runInProject(runId: unknown, project: string): Promise<string> {
    const run =
      typeof runId === 'string'
        ? await db
            .selectFrom('test_runs')
            .innerJoin('test_plans', 'test_plans.id', 'test_runs.test_plan_id')
            .select(['test_runs.id', 'test_plans.project_id'])
            .where('test_runs.id', '=', runId)
            .executeTakeFirst()
        : undefined;
    if (!run || run.project_id !== project) throw new ToolError(`Test run '${String(runId)}' not found in this project (see list_plans_and_runs).`);
    return run.id;
  }

  const steps = (raw: unknown) => (Array.isArray(raw) ? raw.map((s: any) => ({ action: s?.action ?? '', expected_result: s?.expected_result ?? '' })) : undefined);

  return [
    {
      name: 'create_suite',
      description: 'Create a test suite (a folder of test cases), at the top level or inside another suite (see list_suites).',
      write: { permissions: ['SPEC_CREATE'] },
      inputSchema: {
        type: 'object',
        properties: {
          project_id: projectId,
          name: { type: 'string' },
          parent_suite_id: { type: 'string', description: 'The suite to put it in; leave out for the top level.' },
          description: { type: 'string' },
        },
        required: ['project_id', 'name'],
        additionalProperties: false,
      },
      run: async (args, user, request) => {
        const project = await requireProject(user, args.project_id);
        const out = await call(request, 'POST', `/api/v1/projects/${project}/suites`, {
          name: args.name,
          parent_suite_id: args.parent_suite_id ?? null,
          description: args.description ?? null,
        });
        return json({ suite: { id: out.suite.id, name: out.suite.name, parent_suite_id: out.suite.parent_suite_id } });
      },
    },
    {
      name: 'create_case',
      description:
        'Create a test case in a suite. It starts as a DRAFT, which a person reviews and approves in Testify before it can be added to a plan. Returns its readable id (e.g. SHOP-12).',
      write: { permissions: ['SPEC_CREATE'] },
      inputSchema: {
        type: 'object',
        properties: {
          project_id: projectId,
          test_suite_id: { type: 'string', description: 'The suite (see list_suites, or create_suite).' },
          title: { type: 'string' },
          priority: { type: 'string', enum: PRIORITIES, default: 'MEDIUM' },
          execution_type: { type: 'string', enum: EXECUTION_TYPES, default: 'MANUAL' },
          summary: { type: 'string' },
          preconditions: { type: 'string' },
          steps: stepsSchema,
        },
        required: ['project_id', 'test_suite_id', 'title'],
        additionalProperties: false,
      },
      run: async (args, user, request) => {
        const project = await requireProject(user, args.project_id);
        const out = await call(request, 'POST', `/api/v1/projects/${project}/cases`, {
          test_suite_id: args.test_suite_id,
          title: args.title,
          priority: args.priority,
          execution_type: args.execution_type,
          summary: args.summary ?? null,
          preconditions: args.preconditions ?? null,
          steps: steps(args.steps) ?? [],
        });
        return json({
          test_case_id: out.test_case.id,
          external_id: out.test_case.external_id,
          version: { version_number: out.version.version_number, status: out.version.status },
          note: 'Created as a DRAFT; a person approves it in Testify.',
        });
      },
    },
    {
      name: 'update_case',
      description:
        "Edit one test case. title, priority and execution_type change at once. summary, preconditions and steps are the versioned content: they're edited on the case's DRAFT, and an APPROVED case first gets a new DRAFT version (copied from the approved one), which a person approves later. A deprecated case can't be edited. custom_fields are set at once (not versioned).",
      write: { permissions: ['SPEC_EDIT'] },
      inputSchema: {
        type: 'object',
        properties: {
          project_id: projectId,
          test_case_id: caseRef,
          title: { type: 'string' },
          priority: { type: 'string', enum: PRIORITIES },
          execution_type: { type: 'string', enum: EXECUTION_TYPES },
          summary: { type: 'string' },
          preconditions: { type: 'string' },
          steps: stepsSchema,
          custom_fields: customFields,
        },
        required: ['project_id', 'test_case_id'],
        additionalProperties: false,
      },
      run: async (args, user, request) => {
        const project = await requireProject(user, args.project_id);
        const c = await findCase(project, String(args.test_case_id ?? ''));
        const fields = Object.fromEntries(['title', 'priority', 'execution_type'].filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));
        const content = Object.fromEntries(['summary', 'preconditions'].filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));
        if (args.steps !== undefined) content.steps = steps(args.steps);
        const fieldValues = args.custom_fields && typeof args.custom_fields === 'object' ? args.custom_fields : {};
        if (!Object.keys(fields).length && !Object.keys(content).length && !Object.keys(fieldValues).length) {
          throw new ToolError('Nothing to change: give at least one of title, priority, execution_type, summary, preconditions, steps or custom_fields.');
        }

        const changed: string[] = [];
        let version: { version_number: number; status: string } | null = null;
        let newDraft = false;
        if (Object.keys(content).length) {
          // Check the content can change before changing anything else.
          let latest = await versionRepo.findLatestVersion(c.id);
          if (!latest) throw new ToolError(`${c.external_id} has no version to edit.`);
          if (latest.status === 'DEPRECATED') throw new ToolError(`${c.external_id} is deprecated; a person must restore it before it can be edited.`);
          if (latest.status === 'APPROVED') {
            latest = (await call(request, 'POST', `/api/v1/cases/${c.id}/versions`)).version;
            newDraft = true;
          }
          const updated = (await call(request, 'PATCH', `/api/v1/versions/${latest!.id}`, content)).version;
          version = { version_number: updated.version_number, status: updated.status };
          changed.push(...Object.keys(content));
        }
        if (Object.keys(fields).length) {
          await call(request, 'PATCH', `/api/v1/cases/${c.id}`, fields);
          changed.push(...Object.keys(fields));
        }
        if (Object.keys(fieldValues).length) {
          const out = await call(request, 'POST', `/api/v1/projects/${project}/cases/bulk`, { action: 'update', case_ids: [c.id], changes: { custom_fields: fieldValues } });
          const item = out.results[0];
          if (item.status >= 400) throw new ToolError(`Custom fields not saved: ${item.detail} [${item.code}]${changed.length ? ` (already changed: ${changed.join(', ')})` : ''}`);
          changed.push('custom_fields');
        }
        return json({
          test_case_id: c.id,
          external_id: c.external_id,
          changed,
          ...(version ? { version } : {}),
          ...(newDraft ? { note: `The case was approved, so its content was edited in a new DRAFT version ${version!.version_number}; a person approves it in Testify.` } : {}),
        });
      },
    },
    {
      name: 'update_cases',
      description:
        'Change many test cases at once: priority, execution_type, test_suite_id (moves them), and custom_fields. Each case succeeds or fails on its own; the answer lists every case.',
      write: { permissions: ['SPEC_EDIT'], idempotent: true },
      inputSchema: {
        type: 'object',
        properties: {
          project_id: projectId,
          case_ids: caseRefs,
          priority: { type: 'string', enum: PRIORITIES },
          execution_type: { type: 'string', enum: EXECUTION_TYPES },
          test_suite_id: { type: 'string', description: 'Move the cases into this suite.' },
          custom_fields: customFields,
        },
        required: ['project_id', 'case_ids'],
        additionalProperties: false,
      },
      run: async (args, user, request) => {
        const project = await requireProject(user, args.project_id);
        const changes = Object.fromEntries(['priority', 'execution_type', 'test_suite_id', 'custom_fields'].filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));
        const out = await call(request, 'POST', `/api/v1/projects/${project}/cases/bulk`, { action: 'update', case_ids: args.case_ids, changes });
        return json({ summary: out.summary, results: out.results });
      },
    },
    {
      name: 'create_run',
      description: 'Start a test run of a plan (one go at its cases, e.g. a release candidate or a CI build). Run names are unique within a plan.',
      write: { permissions: ['RUN_MANAGE'] },
      inputSchema: {
        type: 'object',
        properties: { project_id: projectId, test_plan_id: { type: 'string', description: 'See list_plans_and_runs.' }, name: { type: 'string' }, description: { type: 'string' } },
        required: ['project_id', 'test_plan_id', 'name'],
        additionalProperties: false,
      },
      run: async (args, user, request) => {
        const project = await requireProject(user, args.project_id);
        const planId = await planInProject(args.test_plan_id, project);
        const out = await call(request, 'POST', `/api/v1/plans/${planId}/runs`, { name: args.name, description: args.description ?? null });
        return json({ run: { id: out.run.id, name: out.run.name, status: out.run.status } });
      },
    },
    {
      name: 'record_results',
      description:
        "Record results for cases in a test run (up to 500). A case already tested in the run gets a new result, which becomes its verdict; changing someone else's result needs EXECUTE_OVERWRITE. A case not yet in the run's plan is added if it is approved. Each result succeeds or fails on its own.",
      write: { permissions: ['EXECUTE_RUN'] },
      inputSchema: {
        type: 'object',
        properties: {
          project_id: projectId,
          test_run_id: { type: 'string', description: 'See list_plans_and_runs.' },
          results: {
            type: 'array',
            minItems: 1,
            maxItems: 500,
            items: {
              type: 'object',
              properties: {
                test_case_id: caseRef,
                verdict: { type: 'string', enum: VERDICTS },
                notes: { type: 'string' },
                failure_message: { type: 'string', description: 'The short error, for a failure' },
                duration_ms: { type: 'integer', minimum: 0 },
              },
              required: ['test_case_id', 'verdict'],
              additionalProperties: false,
            },
          },
        },
        required: ['project_id', 'test_run_id', 'results'],
        additionalProperties: false,
      },
      run: async (args, user, request) => {
        const project = await requireProject(user, args.project_id);
        const runId = await runInProject(args.test_run_id, project);
        if (!Array.isArray(args.results) || !args.results.length) throw new ToolError('results needs at least one result.');
        const results = args.results.map((r: any) => {
          const ref = String(r?.test_case_id ?? '');
          return {
            case_identifier: { external_id: ref, by_uuid: ref },
            verdict: r?.verdict,
            ...(r?.notes !== undefined ? { notes: r.notes } : {}),
            ...(r?.failure_message !== undefined ? { failure_message: r.failure_message } : {}),
            ...(r?.duration_ms !== undefined ? { duration_ms: r.duration_ms } : {}),
          };
        });
        const out = await call(request, 'POST', `/api/v1/runs/${runId}/results/batch`, { results });
        return json({
          summary: { total: out.summary.total_submitted, recorded: out.summary.successful, refused: out.summary.failed },
          results: out.results.map((r: any) => ({
            test_case_id: args.results[r.index]?.test_case_id,
            status: r.status,
            ...(r.status >= 400 ? { code: r.code, detail: r.detail } : { verdict: r.verdict }),
          })),
          run_status: out.run_status,
        });
      },
    },
    {
      name: 'update_plan_cases',
      description:
        "Add cases to a test plan and/or remove them (up to 500 each). Only approved cases can be added. Removing a case that already has results is refused unless retire_if_has_results is true, which retires it: its past results stay in their runs, and later runs leave it out. Each case succeeds or fails on its own.",
      write: { permissions: ['PLAN_MANAGE'], destructive: true, idempotent: true },
      inputSchema: {
        type: 'object',
        properties: {
          project_id: projectId,
          test_plan_id: { type: 'string', description: 'See list_plans_and_runs.' },
          add: caseRefs,
          remove: caseRefs,
          retire_if_has_results: { type: 'boolean', default: false },
        },
        required: ['project_id', 'test_plan_id'],
        additionalProperties: false,
      },
      run: async (args, user, request) => {
        const project = await requireProject(user, args.project_id);
        const planId = await planInProject(args.test_plan_id, project);
        const add = Array.isArray(args.add) ? args.add : [];
        const remove = Array.isArray(args.remove) ? args.remove : [];
        if (!add.length && !remove.length) throw new ToolError('Give cases to add and/or remove.');
        const out: Record<string, unknown> = {};
        if (add.length) out.added = await call(request, 'POST', `/api/v1/plans/${planId}/cases/bulk`, { action: 'add', case_ids: add });
        if (remove.length) {
          out.removed = await call(request, 'POST', `/api/v1/plans/${planId}/cases/bulk`, {
            action: 'remove',
            case_ids: remove,
            retire_if_has_results: args.retire_if_has_results === true,
          });
        }
        const trim = (b: any) => b && { summary: b.summary, results: b.results.map(({ index: _i, ...r }: any) => r) };
        return json({ added: trim(out.added), removed: trim(out.removed) });
      },
    },
  ];
}
