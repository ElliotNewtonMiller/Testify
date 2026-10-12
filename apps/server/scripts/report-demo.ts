/**
 * Fills a running Testify server with a "Report Demo" project whose history exercises every
 * report: a regression, a fix, a flip-flopping case, a pass-after-retry, a slowing case, an
 * always-failing case, a case not run in the latest run, and one never run at all -- plus
 * failure messages, CI runner info, and a couple of results recorded "by hand".
 *
 * Everything goes through the public API (results via the batch route with a machine API
 * token), so it also exercises the real ingestion path.
 *
 *   npx tsx apps/server/scripts/report-demo.ts
 *
 * Env: TESTIFY_URL (default http://localhost:3001), TESTIFY_USER / TESTIFY_PASSWORD
 * (default admin / password).
 */

const BASE = (process.env.TESTIFY_URL || 'http://localhost:3001').replace(/\/$/, '');
const RUNS = 8;

async function api<T = any>(method: string, path: string, token: string | null, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

type V = 'P' | 'F' | 'B' | '-' | 'R'; // pass, fail, blocked, not run, fail-then-pass (retry)

interface DemoCase {
  suite: string;
  title: string;
  automated: boolean;
  /** One verdict per run, oldest first. */
  results: V[];
  message?: string;
  /** Duration per run in ms (automated cases). */
  durations?: number[];
  /** Recorded in the UI by a person instead of by CI. */
  manual?: boolean;
}

const steady = (ms: number) => Array.from({ length: RUNS }, (_, i) => ms + ((i * 37) % 60));

const CASES: DemoCase[] = [
  { suite: 'Checkout', title: 'Add item to cart', automated: true, results: ['P', 'P', 'P', 'P', 'P', 'P', 'P', 'P'], durations: steady(800) },
  { suite: 'Checkout', title: 'Apply discount code', automated: true, results: ['P', 'P', 'P', 'P', 'P', 'P', 'P', 'F'], message: 'Expected order total 90.00, got 100.00', durations: steady(950) },
  { suite: 'Checkout', title: 'Pay with saved card', automated: true, results: ['P', 'F', 'P', 'P', 'F', 'P', 'F', 'F'], message: 'Payment gateway returned 502', durations: steady(1500) },
  { suite: 'Checkout', title: 'Guest checkout', automated: true, results: ['P', 'P', 'P', 'P', 'P', 'P', 'P', 'P'], durations: [1200, 1250, 1180, 1300, 2300, 2450, 2600, 2550] },
  { suite: 'Login', title: 'Login with valid password', automated: true, results: ['P', 'P', 'P', 'P', 'P', 'P', 'P', 'P'], durations: steady(400) },
  { suite: 'Login', title: 'Lockout after 5 failed attempts', automated: true, results: ['P', 'P', 'P', 'P', 'F', 'F', 'F', 'F'], message: 'Timed out waiting for the lockout banner', durations: steady(5000) },
  { suite: 'Login', title: 'Password reset email', automated: true, results: ['P', 'P', 'P', 'P', 'F', 'F', 'F', 'P'], message: 'No email received within 30s', durations: steady(3000) },
  { suite: 'Login', title: 'SSO login', automated: true, results: ['P', 'P', 'P', 'P', 'P', 'P', 'P', 'R'], message: 'IdP redirect timed out', durations: steady(2200) },
  { suite: 'Search', title: 'Search by keyword', automated: false, manual: true, results: ['P', 'P', 'P', 'P', 'P', 'P', 'P', 'P'] },
  { suite: 'Search', title: 'Empty results message', automated: false, manual: true, results: ['P', 'P', 'P', 'P', 'P', 'P', 'P', '-'] },
  { suite: 'Search / Filters', title: 'Filter by price range', automated: true, results: ['P', 'P', 'P', 'P', 'P', 'P', 'B', 'B'], message: 'Search index unavailable', durations: steady(700) },
  { suite: 'Search / Filters', title: 'Sort by rating', automated: true, results: ['-', '-', '-', '-', '-', '-', '-', '-'] },
];

function hex(n: number): string {
  return Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

async function main() {
  const login = await api<{ token: string }>('POST', '/api/v1/auth/login', null, {
    username: process.env.TESTIFY_USER || 'admin',
    password: process.env.TESTIFY_PASSWORD || 'password',
  });
  const jwt = login.token;

  // A free prefix: DEMO, DEMO2, DEMO3...
  const { projects } = await api<{ projects: Array<{ prefix: string }> }>('GET', '/api/v1/projects', jwt);
  let prefix = 'DEMO';
  for (let n = 2; projects.some((p) => p.prefix === prefix); n++) prefix = `DEMO${n}`;
  const { project } = await api('POST', '/api/v1/projects', jwt, { name: `Report Demo${prefix === 'DEMO' ? '' : ` ${prefix.slice(4)}`}`, prefix });
  const pid = project.id as string;
  console.log(`Project "${project.name}" (${prefix})`);

  // Suites, including one nested suite.
  const suiteIds = new Map<string, string>();
  for (const path of ['Checkout', 'Login', 'Search', 'Search / Filters']) {
    const parts = path.split(' / ');
    const parent = parts.length > 1 ? suiteIds.get(parts.slice(0, -1).join(' / ')) : undefined;
    const { suite } = await api('POST', `/api/v1/projects/${pid}/suites`, jwt, { name: parts[parts.length - 1], parent_suite_id: parent ?? null });
    suiteIds.set(path, suite.id);
  }

  // Cases (an admin's new cases are approved straight away, so they can join a plan).
  const caseIds: string[] = [];
  for (const c of CASES) {
    const { test_case } = await api('POST', `/api/v1/projects/${pid}/cases`, jwt, {
      test_suite_id: suiteIds.get(c.suite),
      title: c.title,
      execution_type: c.automated ? 'AUTOMATED' : 'MANUAL',
      priority: c.title.includes('Pay') || c.title.includes('Login') ? 'HIGH' : 'MEDIUM',
      steps: [{ step_number: 1, action: `Do: ${c.title}`, expected_result: 'It works' }],
    });
    caseIds.push(test_case.id);
  }

  const { plan } = await api('POST', `/api/v1/projects/${pid}/plans`, jwt, { name: 'Release Regression' });
  for (const id of caseIds) await api('POST', `/api/v1/plans/${plan.id}/cases`, jwt, { test_case_id: id });

  // A machine token for CI-style results (and for trying the API / MCP afterwards).
  const tokenRes = await api('POST', `/api/v1/projects/${pid}/api-tokens`, jwt, { name: 'Demo CI', capabilities: ['EXECUTE_RUN', 'SPEC_VIEW'] });
  const ciToken = tokenRes.plaintext as string;

  const day = 86_400_000;
  for (let run = 0; run < RUNS; run++) {
    const runStart = Date.now() - (RUNS - run) * day;
    const { run: testRun } = await api('POST', `/api/v1/plans/${plan.id}/runs`, jwt, {
      name: `Run 1.0.${run + 1}`,
      release_date: new Date(runStart).toISOString().slice(0, 10),
    });
    const at = (offsetMin: number) => new Date(runStart + offsetMin * 60_000).toISOString();

    const results: unknown[] = [];
    CASES.forEach((c, i) => {
      const v = c.results[run];
      if (v === '-' || c.manual) return;
      const base = { case_identifier: { external_id: `${prefix}-${i + 1}` }, duration_ms: c.durations?.[run] };
      if (v === 'R') {
        results.push({ ...base, verdict: 'FAILED', executed_at: at(i), failure_message: c.message, stack_trace: `Error: ${c.message}\n    at runTest (tests/${i + 1}.spec.ts:42:7)` });
        results.push({ ...base, verdict: 'PASSED', executed_at: at(i + 1) });
        return;
      }
      const verdict = v === 'P' ? 'PASSED' : v === 'F' ? 'FAILED' : 'BLOCKED';
      results.push({
        ...base,
        verdict,
        executed_at: at(i),
        ...(verdict !== 'PASSED' && c.message ? { failure_message: c.message, stack_trace: `Error: ${c.message}\n    at runTest (tests/${i + 1}.spec.ts:42:7)` } : {}),
      });
    });
    await api('POST', `/api/v1/runs/${testRun.id}/results/batch`, ciToken, {
      environment: 'staging',
      runner_info: { name: 'GitHub Actions', run_id: String(9000 + run), job_name: 'e2e', commit_sha: hex(40), url: `https://ci.example.test/runs/${9000 + run}` },
      results,
    });

    // Manual cases: recorded by a person in the UI (no duration).
    const { cases: planCases } = await api('GET', `/api/v1/plans/${plan.id}/cases?test_run_id=${testRun.id}`, jwt);
    for (const [i, c] of CASES.entries()) {
      if (!c.manual || c.results[run] === '-') continue;
      const pc = planCases.find((x: any) => x.external_id === `${prefix}-${i + 1}`);
      await api('POST', `/api/v1/runs/${testRun.id}/results`, jwt, { test_plan_case_id: pc.test_plan_case_id ?? pc.id, verdict: 'PASSED', notes: 'Checked by hand' });
    }
    console.log(`  Run 1.0.${run + 1}: ${results.length} automated results`);
  }

  console.log(`\nDone. Project id: ${pid}`);
  console.log(`API token (SPEC_VIEW + EXECUTE_RUN, project ${prefix} only):\n  ${ciToken}`);
  console.log(`\nTry:\n  curl -s -X POST ${BASE}/api/v1/projects/${pid}/reports/overview -H "Authorization: Bearer <token>" -H 'content-type: application/json' -d '{}'`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
