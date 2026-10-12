import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database } from '@testify/db';
import { TestRunRepository, CustomFieldRepository, ProjectRepository, TestCaseVersionRepository, TestPlanRepository } from '@testify/db';
import { REPORT_CATALOG, REPORT_DEFINITIONS, renderRunSummaryMarkdown, validateReportParams, type ReportDefinition, type RunSummaryReport } from '@testify/core';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { authenticateRequest, canViewProject, type AuthenticatedUser } from '../middleware/auth.js';
import { ReportError, ReportService } from '../services/reportService.js';
import { CaseFilterService } from '../services/caseFilterService.js';

/** Smaller list sizes than the REST defaults, to keep agent context small. */
const MCP_DEFAULT_LIMIT = 25;

const INSTRUCTIONS = `Testify is a test case management system: projects contain test suites and test cases; a test plan selects cases to run; each test run (also called a build) of a plan records a result per case (PASSED, FAILED, BLOCKED, SKIPPED).
Every tool is read-only. Typical flow: list_projects -> list_plans_and_runs -> report_run_summary (what broke in a run, compared with the previous run, with error messages and how long each failure has been failing) -> report_case_history for a specific case -> report_test_health for flaky/slow/always-failing/stale cases.
Use search_cases / list_report_fields to find cases; most reports take the same "filter" to limit them to matching cases. report_run_summary accepts format "markdown" for a ready-to-post summary.
Rates are fractions between 0 and 1. ${REPORT_DEFINITIONS.flaky}`;

type JsonSchema = Record<string, unknown>;

/** The catalog's param schema as plain JSON Schema (nullable -> type: [t, "null"]). */
function toJsonSchema(report: ReportDefinition): JsonSchema {
  const properties: Record<string, JsonSchema> = {
    project_id: { type: 'string', description: 'Project id (from list_projects).' },
  };
  for (const [key, p] of Object.entries(report.params.properties)) {
    const { nullable, ...rest } = p;
    properties[key] = nullable ? { ...rest, type: [p.type, 'null'] } : { ...rest };
    if (key === 'limit') properties[key] = { ...properties[key], default: MCP_DEFAULT_LIMIT };
  }
  if (report.formats.includes('markdown')) {
    properties.format = { type: 'string', enum: ['json', 'markdown'], default: 'json', description: 'markdown returns a summary ready to paste into a PR comment or chat.' };
  }
  return { type: 'object', properties, required: ['project_id', ...report.params.required], additionalProperties: false };
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  run: (args: Record<string, any>, user: AuthenticatedUser) => Promise<string>;
}

class ToolError extends Error {}

/**
 * MCP endpoint (Streamable HTTP, stateless, JSON responses) at POST /mcp.
 *
 * Authenticates exactly like the REST API (login JWT or tf_ci_ machine token), and every
 * tool checks SPEC_VIEW for the project it's asked about -- a token only ever sees its own
 * project. Report tools are generated from @testify/core's REPORT_CATALOG and call the same
 * ReportService as the REST routes, so agents get exactly the numbers people see.
 *
 * Connect from Claude Code:
 *   claude mcp add --transport http testify http://localhost:3001/mcp --header "Authorization: Bearer tf_ci_..."
 */
export async function registerMcpRoutes(app: FastifyInstance, db: Kysely<Database>, jwtSecret: string) {
  const reports = new ReportService(db);
  const caseFilter = new CaseFilterService(db);
  const projectRepo = new ProjectRepository(db);
  const planRepo = new TestPlanRepository(db);
  const runRepo = new TestRunRepository(db);
  const versionRepo = new TestCaseVersionRepository(db);
  const customFieldRepo = new CustomFieldRepository(db);

  const canView = (user: AuthenticatedUser, projectId: string) => canViewProject(user, projectId, db);

  async function requireProject(user: AuthenticatedUser, projectId: unknown): Promise<string> {
    if (typeof projectId !== 'string' || !projectId) throw new ToolError('project_id is required (see list_projects).');
    if (user.api_token && user.api_token.project_id !== projectId) {
      throw new ToolError(`This API token can only read project '${user.api_token.project_id}'.`);
    }
    if (!(await projectRepo.findById(projectId))) throw new ToolError(`Project '${projectId}' not found.`);
    if (!(await canView(user, projectId))) throw new ToolError(`You don't have SPEC_VIEW on project '${projectId}'.`);
    return projectId;
  }

  const json = (value: unknown) => JSON.stringify(value);

  const baseTools: ToolDef[] = [
    {
      name: 'list_projects',
      description: 'Projects you can read (an API token sees only its own project): id, name, prefix (the start of every case external id, e.g. SHOP-12).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: async (_args, user) => {
        const all = await projectRepo.findAll();
        const visible = [];
        for (const p of all) if (await canView(user, p.id)) visible.push({ id: p.id, name: p.name, prefix: p.prefix, description: p.description });
        return json({ projects: visible });
      },
    },
    {
      name: 'list_plans_and_runs',
      description: "A project's test plans with their most recent runs (newest first). ARCHIVED plans are left out unless include_archived is true.",
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Project id.' },
          include_archived: { type: 'boolean', default: false },
          runs_per_plan: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
        },
        required: ['project_id'],
        additionalProperties: false,
      },
      run: async (args, user) => {
        const projectId = await requireProject(user, args.project_id);
        const perPlan = Math.min(Math.max(Number(args.runs_per_plan) || 10, 1), 50);
        const plans = (await planRepo.findByProject(projectId)).filter((p) => args.include_archived || p.status !== 'ARCHIVED');
        const out = [];
        for (const plan of plans) {
          const runs = await runRepo.findByTestPlan(plan.id);
          out.push({
            id: plan.id,
            name: plan.name,
            status: plan.status,
            run_count: runs.length,
            runs: runs.slice(0, perPlan).map((r) => ({ id: r.id, name: r.name, status: r.status, created_at: r.created_at, release_date: r.release_date })),
          });
        }
        return json({ plans: out });
      },
    },
    {
      name: 'list_report_fields',
      description: 'Properties cases can be filtered or grouped by (built-ins and custom fields), with their kind and options -- use the keys in a "filter" ({ q, filters: [{ field, op, value }] }) or as breakdown group_by.',
      inputSchema: { type: 'object', properties: { project_id: { type: 'string' } }, required: ['project_id'], additionalProperties: false },
      run: async (args, user) => {
        const projectId = await requireProject(user, args.project_id);
        return json({
          fields: await caseFilter.fieldCatalog(projectId),
          operators: {
            any_of: 'ENUM / SINGLE_SELECT / MULTI_SELECT: value is a list of option values',
            all_of: 'MULTI_SELECT: has every listed value',
            contains: 'TEXT: case-insensitive substring',
            is: 'CHECKBOX / BOOLEAN: true or false',
            eq: 'NUMBER / DATE', gte: 'NUMBER / DATE', lte: 'NUMBER / DATE', between: 'NUMBER / DATE: [min, max]',
            is_empty: 'no value', is_not_empty: 'has a value',
          },
        });
      },
    },
    {
      name: 'search_cases',
      description: 'Find test cases by text (external id, title, or the name of a suite they are in) and/or property filters. Returns case ids, external ids, titles, suite paths, priority, execution type and status.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string' },
          q: { type: 'string', description: 'Matches external id, title, or the name of the case\'s suite or any suite above it.' },
          filters: { type: 'array', items: { type: 'object' }, description: 'See list_report_fields.' },
          plan_id: { type: 'string', description: "Needed for the 'in_plan' filter." },
          run_id: { type: 'string', description: "Needed for the 'verdict' filter." },
          limit: { type: 'integer', minimum: 1, maximum: 500, default: MCP_DEFAULT_LIMIT },
        },
        required: ['project_id'],
        additionalProperties: false,
      },
      run: async (args, user) => {
        const projectId = await requireProject(user, args.project_id);
        const outcome = await caseFilter.evaluate(projectId, { q: args.q, filters: args.filters, plan_id: args.plan_id, build_id: args.run_id });
        if (!outcome.ok) throw new ToolError(`${outcome.error}${outcome.details ? `: ${JSON.stringify(outcome.details)}` : ''}`);
        const limit = Math.min(Math.max(Number(args.limit) || MCP_DEFAULT_LIMIT, 1), 500);
        return json({
          total_matches: outcome.case_ids.length,
          total_cases: outcome.total_cases,
          cases: await reports.describeCases(projectId, outcome.case_ids.slice(0, limit)),
        });
      },
    },
    {
      name: 'get_case',
      description: "One test case's content: title, suite, priority, latest version (status, summary, preconditions, steps with expected results) and custom field values.",
      inputSchema: {
        type: 'object',
        properties: { project_id: { type: 'string' }, case_id: { type: 'string', description: 'Case id or external id such as SHOP-12.' } },
        required: ['project_id', 'case_id'],
        additionalProperties: false,
      },
      run: async (args, user) => {
        const projectId = await requireProject(user, args.project_id);
        const c = await reports.findCase(projectId, String(args.case_id ?? ''));
        const [version, values] = await Promise.all([
          versionRepo.findLatestVersion(c.id),
          customFieldRepo.getValuesForEntity('TestCase', c.id, projectId),
        ]);
        return json({
          id: c.id,
          external_id: c.external_id,
          title: c.title,
          suite_path: c.suite_path,
          priority: c.priority,
          execution_type: c.execution_type,
          latest_version: version
            ? {
                version_number: version.version_number,
                status: version.status,
                summary: version.summary,
                preconditions: version.preconditions,
                steps: version.steps.map((s) => ({ step_number: s.step_number, action: s.action, expected_result: s.expected_result })),
              }
            : null,
          custom_fields: values.map((v) => ({ field: v.definition.field_label, value: v.value })),
        });
      },
    },
  ];

  const reportTools: ToolDef[] = REPORT_CATALOG.map((report) => ({
    name: `report_${report.id}`,
    description: `${report.title}: ${report.description}`,
    inputSchema: toJsonSchema(report),
    run: async (args, user) => {
      const projectId = await requireProject(user, args.project_id);
      const { project_id: _p, format, ...rest } = args;
      if ('limit' in report.params.properties && rest.limit === undefined) rest.limit = MCP_DEFAULT_LIMIT;
      const validation = validateReportParams(report, rest);
      if (!validation.ok) throw new ToolError(validation.errors.map((e) => `${e.param} ${e.reason}`).join('; '));
      const output = await reports.run(projectId, report.id, validation.params);
      if (format === 'markdown' && report.id === 'run_summary') return renderRunSummaryMarkdown(output.data as RunSummaryReport);
      return json(output.data);
    },
  }));

  const tools = [...baseTools, ...reportTools];
  const toolByName = new Map(tools.map((t) => [t.name, t]));

  function buildServer(user: AuthenticatedUser): Server {
    const server = new Server({ name: 'testify', version: '1.0.0' }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as any, annotations: { readOnlyHint: true } })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const tool = toolByName.get(req.params.name);
      if (!tool) return { isError: true, content: [{ type: 'text', text: `Unknown tool '${req.params.name}'` }] };
      try {
        const text = await tool.run((req.params.arguments ?? {}) as Record<string, any>, user);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        if (err instanceof ToolError || err instanceof ReportError) {
          return { isError: true, content: [{ type: 'text', text: err.message }] };
        }
        throw err;
      }
    });
    return server;
  }

  app.post('/mcp', async (request, reply) => {
    const user = await authenticateRequest(request, reply, db, jwtSecret);
    if (!user) return; // 401 already sent

    // Stateless: a fresh server + transport per request, bound to this caller.
    const server = buildServer(user);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  // No server-initiated streams or sessions in stateless mode.
  const methodNotAllowed = async (_request: unknown, reply: any) =>
    reply.status(405).header('Allow', 'POST').send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. Use POST.' }, id: null });
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);
}
