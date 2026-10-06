import React from "react";
import {
  CaseCell,
  Empty,
  ErrorNote,
  FlakyBadge,
  Kpi,
  Loading,
  Section,
  VerdictBar,
  VerdictCounts,
  VerdictPill,
  buttonStyle,
  downloadReportCsv,
  fmtMs,
  fmtWhen,
  pct,
  runReport,
  selectStyle,
  tdStyle,
  thStyle,
  useReport,
  type CaseRef,
  type RunRef,
  type VerdictSummary,
} from "./shared";

interface DiffCase extends CaseRef {
  verdict: string | null;
  previous_verdict: string | null;
}

interface Failure extends CaseRef {
  verdict: string;
  failure_message: string | null;
  notes: string | null;
  executed_at: string | null;
  tested_by: string | null;
  source: string | null;
  attempts: number;
  failing_since: { run_id: string; run_name: string; runs: number } | null;
  flaky: boolean;
  runner: Record<string, string> | null;
}

interface RunSummary {
  run: RunRef;
  compared_to: RunRef | null;
  filter_applied: boolean;
  summary: VerdictSummary & { attempts: number; automated_duration_ms: number | null };
  diff: {
    counts: Record<string, number>;
    cases: Record<"new_failure" | "fixed" | "still_failing" | "not_run" | "added" | "removed", DiffCase[]>;
    truncated: boolean;
  };
  failures: Failure[];
  failures_truncated: boolean;
  runners: Array<Record<string, string>>;
}

const DIFF_LABELS: Array<{ key: keyof RunSummary["diff"]["cases"]; label: string; color: string }> = [
  { key: "new_failure", label: "New failures", color: "#f87171" },
  { key: "fixed", label: "Fixed", color: "#4ade80" },
  { key: "still_failing", label: "Still failing", color: "#fb923c" },
  { key: "not_run", label: "Not run this time", color: "#94a3b8" },
  { key: "added", label: "Only in this run", color: "#94a3b8" },
  { key: "removed", label: "Only in the compared run", color: "#94a3b8" },
];

/** "previous" = the default (previous run of the plan); "none" = no comparison. */
export type CompareChoice = "previous" | "none" | string;

/** One run: what happened, what changed since the compared run, and every failure. */
export function RunTab({
  projectId,
  runId,
  runs,
  compareTo,
  onCompareToChange,
  filter,
  onOpenCase,
}: {
  projectId: string;
  runId: string;
  runs: Array<{ id: string; name: string }>;
  compareTo: CompareChoice;
  onCompareToChange: (c: CompareChoice) => void;
  filter: Record<string, unknown> | null;
  onOpenCase: (caseId: string) => void;
}) {
  const params = React.useMemo(() => {
    if (!runId) return null;
    const p: Record<string, unknown> = { run_id: runId, limit: 500 };
    if (compareTo === "none") p.compare_to = null;
    else if (compareTo !== "previous") p.compare_to = compareTo;
    if (filter) p.filter = filter;
    return p;
  }, [runId, compareTo, filter]);
  const { data, error, loading } = useReport<RunSummary>(projectId, "run_summary", params);
  const [copyState, setCopyState] = React.useState<string | null>(null);
  const [openLists, setOpenLists] = React.useState<Record<string, boolean>>({ fixed: true });

  if (!runId) return <Empty>Pick a test run in the header (Run) to see its summary. A plan needs at least one run.</Empty>;
  if (error) return <ErrorNote message={error} />;
  if (!data) return loading ? <Loading /> : null;

  const s = data.summary;
  const copyMarkdown = async () => {
    try {
      const md = await runReport<string>(projectId, "run_summary", params!, "markdown");
      await navigator.clipboard.writeText(md);
      setCopyState("Copied");
    } catch (e) {
      setCopyState(e instanceof Error ? e.message : "Copy failed");
    }
    setTimeout(() => setCopyState(null), 2500);
  };
  const failureById = new Map(data.failures.map((f) => [f.test_case_id, f]));
  const commits = [...new Set(data.runners.map((r) => r.commit_sha).filter(Boolean))];
  const ciLinks = data.runners.filter((r) => r.url);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <Section
        title={`Run: ${data.run.name}`}
        subtitle={
          <>
            Plan: {data.run.plan_name} · {data.run.status === "CLOSED" ? "closed" : "open"}
            {data.filter_applied && <span style={{ color: "#fbbf24" }}> · limited to the cases matching your filter</span>}
          </>
        }
        actions={
          <>
            <label style={{ fontSize: "11px", color: "#94a3b8", display: "flex", alignItems: "center", gap: "6px" }}>
              Compare to
              <select value={compareTo} onChange={(e) => onCompareToChange(e.target.value)} style={selectStyle}>
                <option value="previous">Previous run</option>
                <option value="none">Nothing</option>
                {runs
                  .filter((r) => r.id !== runId)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
              </select>
            </label>
            <button style={buttonStyle} onClick={copyMarkdown} title="Copy this summary as Markdown, for a PR comment, chat message or ticket">
              {copyState ?? "Copy as Markdown"}
            </button>
            <button style={buttonStyle} onClick={() => downloadReportCsv(projectId, "run_summary", params!, `run-${data.run.name}.csv`)}>
              CSV
            </button>
          </>
        }
      >
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "10px", marginBottom: "10px" }}>
          <Kpi label="Pass rate" value={pct(s.pass_rate)} info="Passed ÷ executed. Untested and skipped cases don't count." />
          <Kpi label="Executed" value={`${s.total - s.untested} / ${s.total}`} hint={pct(s.completion)} info="Cases with a result in this run, out of every case in the plan." />
          <Kpi label="Failing" value={s.failed + s.blocked} color={s.failed + s.blocked > 0 ? "#f87171" : undefined} hint={`${s.failed} failed · ${s.blocked} blocked`} info="Failed and blocked cases both count as failing." />
          <Kpi label="Automated time" value={fmtMs(s.automated_duration_ms)} hint={`${s.attempts} result${s.attempts === 1 ? "" : "s"} recorded`} info="Total duration of automated results. Results recorded by people aren't timed." />
        </div>
        <VerdictBar summary={s} height={10} />
        <div style={{ marginTop: "8px" }}>
          <VerdictCounts summary={s} />
        </div>
        {(commits.length > 0 || ciLinks.length > 0) && (
          <div style={{ fontSize: "11px", color: "#64748b", marginTop: "8px", display: "flex", gap: "10px", flexWrap: "wrap" }}>
            {commits.length > 0 && (
              <span>
                Commits:{" "}
                {commits.map((c) => (
                  <code key={c} style={{ color: "#94a3b8", marginRight: 6 }}>
                    {c.slice(0, 12)}
                  </code>
                ))}
              </span>
            )}
            {ciLinks.slice(0, 5).map((r) => (
              <a key={r.url} href={r.url} target="_blank" rel="noreferrer" style={{ color: "#7dd3fc" }}>
                {r.name || "CI"} {r.run_id ? `#${r.run_id}` : ""} ↗
              </a>
            ))}
          </div>
        )}
      </Section>

      {data.compared_to && (
        <Section title={`Changes since: ${data.compared_to.name}`} subtitle={data.compared_to.plan_id !== data.run.plan_id ? `Plan: ${data.compared_to.plan_name}` : undefined}
          info="How each case's result changed since the compared run. Click a count to list its cases.">
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "8px" }}>
            {DIFF_LABELS.filter((d) => (d.key !== "added" && d.key !== "removed") || data.diff.counts[d.key] > 0).map((d) => (
              <button
                key={d.key}
                onClick={() => setOpenLists((o) => ({ ...o, [d.key]: !o[d.key] }))}
                style={{ ...buttonStyle, borderColor: data.diff.counts[d.key] > 0 ? d.color : "#334155", color: data.diff.counts[d.key] > 0 ? d.color : "#64748b" }}
              >
                {data.diff.counts[d.key]} {d.label.toLowerCase()} {openLists[d.key] ? "▾" : "▸"}
              </button>
            ))}
          </div>
          {DIFF_LABELS.filter((d) => openLists[d.key]).map((d) => (
            <div key={d.key} style={{ marginBottom: "8px" }}>
              <div style={{ fontSize: "11px", fontWeight: 700, color: d.color, margin: "4px 0" }}>{d.label}</div>
              {data.diff.cases[d.key].length === 0 ? (
                <Empty>None.</Empty>
              ) : (
                data.diff.cases[d.key].map((c) => {
                  const failure = failureById.get(c.test_case_id);
                  const message = failure ? failure.failure_message || failure.notes : null;
                  return (
                    <div key={c.test_case_id} style={{ padding: "2px 0" }}>
                      <div style={{ display: "flex", gap: "8px", alignItems: "center", fontSize: "12px" }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <CaseCell c={c} onOpen={onOpenCase} badge={failure?.flaky ? <FlakyBadge /> : undefined} />
                        </div>
                        <VerdictPill verdict={c.previous_verdict} />
                        <span style={{ color: "#475569" }}>→</span>
                        <VerdictPill verdict={c.verdict} />
                      </div>
                      {message && <div style={{ fontSize: "11px", color: "#fca5a5", margin: "1px 0 2px 0", wordBreak: "break-word" }}>{message}</div>}
                    </div>
                  );
                })
              )}
            </div>
          ))}
          {data.diff.truncated && <Empty>Some lists are truncated.</Empty>}
        </Section>
      )}

      <Section title={`Failures (${s.failed + s.blocked})`} info={`${data.compared_to ? "New failures first. " : ""}"Failing since" is the first run of the current unbroken failing streak. Click a case for its full history.`}>
        {data.failures.length === 0 ? (
          <Empty>No failing or blocked cases in this run.</Empty>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={thStyle}>Case</th>
                  <th style={thStyle}>Verdict</th>
                  <th style={thStyle}>Failing since</th>
                  <th style={thStyle}>Error / notes</th>
                  <th style={thStyle}>By</th>
                </tr>
              </thead>
              <tbody>
                {data.failures.map((f) => {
                  const isNew = data.diff.cases.new_failure.some((n) => n.test_case_id === f.test_case_id);
                  return (
                    <tr key={f.test_case_id}>
                      <td style={{ ...tdStyle, maxWidth: 340 }}>
                        <CaseCell
                          c={f}
                          onOpen={onOpenCase}
                          badge={
                            <>
                              {isNew && <span style={{ fontSize: "10px", fontWeight: 700, color: "#f87171", flexShrink: 0 }}>NEW</span>}
                              {f.flaky && <FlakyBadge />}
                            </>
                          }
                        />
                      </td>
                      <td style={tdStyle}>
                        <VerdictPill verdict={f.verdict} />
                        {f.attempts > 1 && <div style={{ fontSize: "10px", color: "#64748b", marginTop: 2 }}>{f.attempts} attempts</div>}
                      </td>
                      <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                        {f.failing_since ? (
                          <>
                            {f.failing_since.run_name}
                            <div style={{ fontSize: "10px", color: "#64748b" }}>
                              {f.failing_since.runs} run{f.failing_since.runs === 1 ? "" : "s"}
                            </div>
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td style={{ ...tdStyle, color: f.failure_message ? "#fca5a5" : "#94a3b8", maxWidth: 420, wordBreak: "break-word" }}>
                        {f.failure_message || f.notes || <span style={{ color: "#475569" }}>No message</span>}
                      </td>
                      <td style={{ ...tdStyle, whiteSpace: "nowrap", color: "#94a3b8" }}>
                        {f.tested_by ?? "—"}
                        <div style={{ fontSize: "10px", color: "#64748b" }}>{fmtWhen(f.executed_at)}</div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {data.failures_truncated && <Empty>Showing the first {data.failures.length}; download the CSV for all.</Empty>}
          </div>
        )}
      </Section>
    </div>
  );
}
