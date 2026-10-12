import React from "react";
import {
  CaseCell,
  Empty,
  ErrorNote,
  Loading,
  Section,
  VerdictPill,
  buttonStyle,
  downloadReportCsv,
  fmtMs,
  fmtWhen,
  selectStyle,
  tdStyle,
  thStyle,
  useReport,
  runLabel,
  useEmailContext,
  type EmailContext,
  type CaseRef,
} from "./shared";

type Row = CaseRef & Record<string, any>;

interface HealthReport {
  runs_analysed: Array<{ id: string; name: string }>;
  counts: Record<string, number>;
  flaky: Row[];
  slowest: Row[];
  slowing: Row[];
  always_failing: Row[];
  stale: Row[];
}

/** Problem cases across a plan's recent runs. */
export function HealthTab({ projectId, planId, filter, onOpenCase, onEmailContext }: { projectId: string; planId: string; filter: Record<string, unknown> | null; onOpenCase: (caseId: string) => void; onEmailContext?: (ctx: EmailContext | null) => void }) {
  const [runs, setRuns] = React.useState(10);
  const [staleDays, setStaleDays] = React.useState(30);
  const params = React.useMemo(
    () => (planId ? { test_plan_id: planId, runs, stale_days: staleDays, limit: 50, ...(filter ? { filter } : {}) } : null),
    [planId, runs, staleDays, filter]
  );
  const { data, error, loading } = useReport<HealthReport>(projectId, "test_health", params);
  useEmailContext(onEmailContext, params ? { what: `Test health over the last ${runs} runs${filter ? ", limited to your filter" : ""}`, sections: [{ report_id: "test_health", params: { ...params, limit: 10 } }] } : null);

  if (!planId) return <Empty>Pick a test plan in the header to see its test health.</Empty>;

  const table = (rows: Row[], columns: Array<{ label: string; render: (r: Row) => React.ReactNode }>, empty: string, total: number) =>
    rows.length === 0 ? (
      <Empty>{empty}</Empty>
    ) : (
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={thStyle}>Case</th>
              {columns.map((c) => (
                <th key={c.label} style={thStyle}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.test_case_id}>
                <td style={{ ...tdStyle, maxWidth: 380 }}>
                  <CaseCell c={r} onOpen={onOpenCase} />
                </td>
                {columns.map((c) => (
                  <td key={c.label} style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                    {c.render(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {total > rows.length && <Empty>Showing {rows.length} of {total}; download the CSV for all.</Empty>}
      </div>
    );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap", fontSize: "11px", color: "#94a3b8" }}>
        <label style={{ display: "flex", gap: "6px", alignItems: "center" }}>
          Analyse the last
          <select value={runs} onChange={(e) => setRuns(Number(e.target.value))} style={selectStyle}>
            {[5, 10, 20, 50].map((n) => (
              <option key={n} value={n}>
                {n} runs
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", gap: "6px", alignItems: "center" }}>
          Stale after
          <input
            type="number"
            min={1}
            max={3650}
            value={staleDays}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n >= 1 && n <= 3650) setStaleDays(n);
            }}
            style={{ ...selectStyle, width: 64 }}
          />
          days
        </label>
        {data && <span style={{ color: "#64748b" }}>{data.runs_analysed.length} run{data.runs_analysed.length === 1 ? "" : "s"} analysed</span>}
        {params && (
          <button style={{ ...buttonStyle, marginLeft: "auto" }} onClick={() => downloadReportCsv(projectId, "test_health", { ...params, limit: 500 }, "test-health.csv")}>
            CSV
          </button>
        )}
      </div>

      {error ? (
        <ErrorNote message={error} />
      ) : !data ? (
        loading ? <Loading /> : null
      ) : (
        <>
          <Section title={`Flaky (${data.counts.flaky})`} info="Pass/fail flip-flopping between runs (a single break or fix doesn't count), or both passing and failing within one run.">
            {table(
              data.flaky,
              [
                { label: "Flip score", render: (r) => r.flip_score.toFixed(2) },
                { label: "Flips", render: (r) => `${r.flips} in ${r.runs_with_result} runs` },
                { label: "Passed on retry", render: (r) => (r.passed_on_retry_runs ? `${r.passed_on_retry_runs} run${r.passed_on_retry_runs === 1 ? "" : "s"}` : "—") },
                { label: "Last", render: (r) => <VerdictPill verdict={r.last_verdict} /> },
              ],
              "Nothing flaky in this window.",
              data.counts.flaky
            )}
          </Section>

          <Section title={`Always failing (${data.counts.always_failing})`} info="Failed or blocked in each of the last 3 or more runs it was executed in.">
            {table(
              data.always_failing,
              [
                { label: "In a row", render: (r) => `${r.consecutive_failures} runs` },
                { label: "Since", render: (r) => r.failing_since ? runLabel(r.failing_since.run_name) : "—" },
                { label: "Last error", render: (r) => <span style={{ color: "#fca5a5", whiteSpace: "normal" }}>{r.last_failure_message ?? "—"}</span> },
              ],
              "Nothing has been failing run after run.",
              data.counts.always_failing
            )}
          </Section>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))", gap: "14px" }}>
            <Section title={`Slowest (${data.counts.slowest})`} info="Median duration of automated results. People's results aren't timed.">
              {table(
                data.slowest,
                [
                  { label: "Median", render: (r) => fmtMs(r.median_ms) },
                  { label: "Last", render: (r) => fmtMs(r.last_ms) },
                ],
                "No timed (automated) results yet.",
                data.counts.slowest
              )}
            </Section>
            <Section title={`Getting slower (${data.counts.slowing})`} info="Recent median vs. older median, 1.2× or more (needs 4+ timed runs).">
              {table(
                data.slowing,
                [
                  { label: "Slowdown", render: (r) => <span style={{ color: "#fbbf24" }}>{r.slowdown.toFixed(2)}×</span> },
                  { label: "Before → now", render: (r) => `${fmtMs(r.older_median_ms)} → ${fmtMs(r.recent_median_ms)}` },
                ],
                "Nothing is getting slower.",
                data.counts.slowing
              )}
            </Section>
          </div>

          <Section title={`Stale (${data.counts.stale})`} info={`Not executed in any plan for ${staleDays} days, or never.`}>
            {table(
              data.stale,
              [
                { label: "Last executed", render: (r) => (r.last_executed_at ? fmtWhen(r.last_executed_at) : <span style={{ color: "#fbbf24" }}>Never</span>) },
                { label: "Days ago", render: (r) => r.days_since ?? "—" },
              ],
              "Every case has run recently.",
              data.counts.stale
            )}
          </Section>
        </>
      )}
    </div>
  );
}
