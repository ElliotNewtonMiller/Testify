// @vitest-environment jsdom
/**
 * Smoke tests for the whole app: <App /> rendered against a small fake API. They pin down the
 * main flows (sign-in, the Project/Plan/Run header, Spec and Execute mode, recording a result,
 * permissions) so App.tsx can be restructured without silently breaking them. They check what
 * a person sees and which requests go out -- not internal state -- so they survive the code
 * moving around.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup, within } from '@testing-library/react';
import App from '../App';

const ALL_PERMISSIONS = [
  'SYSTEM_ADMIN', 'USER_MANAGE', 'PROJECT_CREATE', 'PROJECT_DELETE', 'SPEC_VIEW', 'SPEC_CREATE', 'SPEC_EDIT',
  'SPEC_APPROVE', 'SPEC_DELETE', 'SPEC_AUTO_APPROVE', 'PLAN_MANAGE', 'RUN_MANAGE', 'EXECUTE_RUN',
  'EXECUTE_OVERWRITE', 'IMPORT_DATA', 'EXPORT_DATA', 'API_TOKEN_MANAGE', 'CUSTOM_FIELD_MANAGE', 'REPORT_EMAIL',
];
const user = (username: string, global_role: string, permissions: string[]) => ({
  id: `usr-${username}`, username, email: `${username}@testify.local`, global_role, permissions, must_change_password: false,
});
const ADMIN = user('admin', 'Admin', ALL_PERMISSIONS);
const VIEWER = user('viewer', 'Viewer', ['SPEC_VIEW', 'EXPORT_DATA']);

const T = '2026-10-01T00:00:00.000Z';
const project = { id: 'prj-1', name: 'Smoke Project', prefix: 'SMK', description: null, settings: '{}', created_at: T, updated_at: T };
const plan = { id: 'pln-1', project_id: 'prj-1', name: 'Regression', description: null, status: 'ACTIVE', created_at: T, updated_at: T };
const run = { id: 'bld-1', test_plan_id: 'pln-1', name: 'Run 1', description: null, status: 'OPEN', release_date: T, created_at: T, updated_at: T };
const suite = (id: string, name: string, cases: number) => ({
  id, project_id: 'prj-1', parent_suite_id: null, name, description: null, position: 0, path: `/${id}`,
  created_at: T, updated_at: T, children: [], total_case_count: cases, in_plan_count: cases,
});
const steps = (caseNo: number) => [
  { id: `stp-${caseNo}-1`, step_number: 1, action: `Open screen ${caseNo}`, expected_result: 'It opens' },
  { id: `stp-${caseNo}-2`, step_number: 2, action: `Press save ${caseNo}`, expected_result: 'It saves' },
];
const CASES = [
  { n: 1, title: 'Log in with a password', suite: 'ste-login' },
  { n: 2, title: 'Lock out after failures', suite: 'ste-login' },
  { n: 3, title: 'Pay by card', suite: 'ste-pay' },
];
const specCase = (c: (typeof CASES)[number]) => ({
  id: `cas-${c.n}`, external_id: `SMK-${c.n}`, title: c.title, priority: 'MEDIUM', execution_type: 'MANUAL', test_suite_id: c.suite,
  latest_version: { id: `ver-${c.n}`, version_number: 1, status: 'APPROVED', summary: `Summary ${c.n}`, preconditions: null, updated_at: T },
  in_plan: true, plan_case_id: `tpc-${c.n}`, plan_version_id: `ver-${c.n}`, is_pinned_version_stale: false, linkable: true,
});
const queueCase = (c: (typeof CASES)[number]) => ({
  plan_case_id: `tpc-${c.n}`, position: c.n, case_id: `cas-${c.n}`, test_suite_id: c.suite, external_id: `SMK-${c.n}`,
  title: c.title, priority: 'MEDIUM', execution_type: 'MANUAL', version_id: `ver-${c.n}`, version_number: 1,
  version_status: 'APPROVED', summary: `Summary ${c.n}`, preconditions: null, steps: steps(c.n),
  latest_verdict: 'UNTESTED', latest_execution_id: null, latest_notes: null, removed_from_plan: false,
});
const latestVersion = (n: number) => {
  const c = CASES[n - 1];
  return {
    test_case: { id: `cas-${n}`, project_id: 'prj-1', test_suite_id: c.suite, external_id: `SMK-${n}`, title: c.title, priority: 'MEDIUM', execution_type: 'MANUAL', created_at: T, updated_at: T },
    version: {
      id: `ver-${n}`, test_case_id: `cas-${n}`, version_number: 1, status: 'APPROVED', summary: `Summary ${n}`, preconditions: null,
      author_id: 'usr-admin', reviewer_id: 'usr-admin', created_at: T, updated_at: T,
      steps: steps(n).map((s) => ({ ...s, test_case_version_id: `ver-${n}`, execution_type: 'MANUAL', created_at: T, updated_at: T })),
    },
  };
};

type Call = { method: string; path: string; body: any };
let calls: Call[] = [];

/** Serves the fixture above. `signedIn: null` makes /auth/me answer 401 (signed out). */
function installApi(opts: { signedIn: ReturnType<typeof user> | null; executionStatus?: number }) {
  calls = [];
  const json = (data: unknown, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));
  const fake = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
    const method = (init?.method || 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ method, path: url.pathname, body });
    const p = url.pathname;
    if (p === '/api/v1/auth/me') return opts.signedIn ? json({ user: opts.signedIn }) : json({ error: 'Unauthorized' }, 401);
    if (p === '/api/v1/projects' && method === 'GET') return json({ projects: [project] });
    if (p === '/api/v1/projects/prj-1/plans') return json({ plans: [plan] });
    if (p === '/api/v1/projects/prj-1/plans/pln-1/builds') return json({ builds: [run] });
    if (p === '/api/v1/projects/prj-1/spec-tree')
      return json({ project: { id: 'prj-1', name: project.name, prefix: 'SMK', settings: {} }, suites: [suite('ste-login', 'Login', 2), suite('ste-pay', 'Payments', 1)], cases: CASES.map(specCase) });
    if (p === '/api/v1/projects/prj-1/case-search/fields') return json({ fields: [] });
    if (p === '/api/v1/test-plans/pln-1/cases') return json({ plan, builds: [run], cases: CASES.map(queueCase) });
    const latest = p.match(/^\/api\/v1\/test-cases\/cas-(\d+)\/latest-version$/);
    if (latest) return json(latestVersion(Number(latest[1])));
    if (/custom-field-values$/.test(p)) return json({ values: [] });
    if (p === '/api/v1/executions' && method === 'POST') {
      const status = opts.executionStatus ?? 201;
      return status === 201
        ? json({ id: 'exe-1', verdict: body.verdict, status: 'COMPLETED', created_at: T, build_status: 'OPEN' }, 201)
        : json({ error: 'Forbidden: Insufficient privileges' }, status);
    }
    return json({ error: `no fixture for ${method} ${p}` }, 404);
  });
  vi.stubGlobal('fetch', fake);
  window.fetch = fake as unknown as typeof window.fetch;
}

beforeEach(() => {
  window.location.hash = '';
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Signs in (via /auth/me) and waits until the workspace has loaded the fixture's scope. */
async function renderSignedIn(signedIn = ADMIN, executionStatus?: number) {
  installApi({ signedIn, executionStatus });
  render(<App />);
  await screen.findByRole('button', { name: /Sign Out/ });
  await waitFor(() => expect(screen.getByDisplayValue('Smoke Project (SMK)')).toBeTruthy());
  await waitFor(() => expect(screen.getByDisplayValue(/Regression/)).toBeTruthy());
  await waitFor(() => expect(screen.getByDisplayValue(/Run 1/)).toBeTruthy());
}

describe('App smoke tests', () => {
  it('shows the login page when signed out', async () => {
    installApi({ signedIn: null });
    render(<App />);
    expect(await screen.findByRole('button', { name: /^Log In$/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Sign Out/ })).toBeNull();
  });

  it('shows the selected project, plan and run in the header', async () => {
    await renderSignedIn();
    expect(screen.getByDisplayValue('Smoke Project (SMK)')).toBeTruthy();
    expect(screen.getByDisplayValue(/Regression/)).toBeTruthy();
    expect(screen.getByDisplayValue(/Run 1/)).toBeTruthy();
  });

  it('opens in Spec mode with the suite tree and the case list', async () => {
    await renderSignedIn();
    expect(await screen.findByText('Login')).toBeTruthy();
    expect(screen.getByText('Payments')).toBeTruthy();
    for (const c of CASES) expect(await screen.findByText(`SMK-${c.n}`)).toBeTruthy();
  });

  it("selecting a case shows its details and steps", async () => {
    await renderSignedIn();
    fireEvent.click(await screen.findByText('SMK-3'));
    await waitFor(() => expect(screen.getByDisplayValue('Pay by card')).toBeTruthy());
    await waitFor(() => expect(calls.some((c) => c.path === '/api/v1/test-cases/cas-3/latest-version')).toBe(true));
    expect(await screen.findByText(/Open screen 3/)).toBeTruthy();
  });

  it('Execute mode shows the queue, and Pass records a result against the selected run', async () => {
    await renderSignedIn();
    fireEvent.click(screen.getByRole('button', { name: /^Execute$/ }));
    await waitFor(() => expect(calls.some((c) => c.path === '/api/v1/test-plans/pln-1/cases')).toBe(true));
    // (The active case's title shows twice: in the queue and in the detail pane.)
    for (const c of CASES) expect((await screen.findAllByText(c.title)).length).toBeGreaterThan(0);

    fireEvent.click(await screen.findByRole('button', { name: /^Pass$/ }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/v1/executions')).toBe(true));
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/v1/executions')!;
    expect(post.body).toMatchObject({ build_id: 'bld-1', test_plan_case_id: 'tpc-1', verdict: 'PASSED' });
  });

  it("a Viewer doesn't get editing or admin controls", async () => {
    await renderSignedIn(VIEWER);
    await screen.findByText('SMK-1');
    expect(screen.queryByRole('button', { name: /Admin Panel/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Import/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /\+ Suite/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /\+ Case/ })).toBeNull();
    // An admin does get them.
    cleanup();
    await renderSignedIn(ADMIN);
    expect(screen.getByRole('button', { name: /Admin Panel/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Import/ })).toBeTruthy();
  });

  it('shows the "Not permitted" banner when the server refuses a result', async () => {
    await renderSignedIn(ADMIN, 403);
    fireEvent.click(screen.getByRole('button', { name: /^Execute$/ }));
    for (const c of CASES) await screen.findAllByText(c.title);
    fireEvent.click(await screen.findByRole('button', { name: /^Pass$/ }));
    const banner = await screen.findByRole('alert');
    expect(within(banner).getByText(/Not permitted/)).toBeTruthy();
  });
});
