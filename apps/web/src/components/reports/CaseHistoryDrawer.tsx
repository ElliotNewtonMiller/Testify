import React from "react";
import { ErrorNote, Kpi, Loading, VerdictPill, buttonStyle, downloadReportCsv, fmtMs, fmtWhen, pct, runReport, type CaseRef } from "./shared";

interface Execution {
  execution_id: string;
  executed_at: string;
  verdict: string;
  run: { id: string; name: string };
  plan: { id: string; name: string };
  version_number: number | null;
  duration_ms: number | null;
  tested_by: string;
  source: string | null;
  notes: string | null;
  failure_message: string | null;
  stack_trace: string | null;
  environment: Record<string, string> | null;
  runner: Record<string, string> | null;
}

interface CaseHistory {
  case: CaseRef & { priority: string; execution_type: string; version_status: string | null };
  stats: {
    total_executions: number;
    runs: number;
    pass_rate: number;
    last_executed_at: string | null;
    last_passed_at: string | null;
    last_failed_at: string | null;
    current_streak: { verdict: string; runs: number } | null;
  };
  executions: Execution[];
  next_cursor: string | null;
}

const PAGE = 25;

/** Every result a case ever got, across plans and runs. Opened from any case in Reports. */
export function CaseHistoryDrawer({ projectId, caseId, onClose, onOpenInSpec }: { projectId: string; caseId: string; onClose: () => void; onOpenInSpec: (caseId: string) => void }) {
  const [data, setData] = React.useState<CaseHistory | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [openTraces, setOpenTraces] = React.useState<Set<string>>(new Set());

  React.useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    runReport<CaseHistory>(projectId, "case_history", { case_id: caseId, limit: PAGE })
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [projectId, caseId]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const loadMore = async () => {
    if (!data?.next_cursor) return;
    setLoadingMore(true);
    try {
      const next = await runReport<CaseHistory>(projectId, "case_history", { case_id: caseId, limit: PAGE, cursor: data.next_cursor });
      setData({ ...next, executions: [...data.executions, ...next.executions] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMore(false);
    }
  };

  const streak = data?.stats.current_streak;
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 900, display: "flex", justifyContent: "flex-end" }}>
      <div onClick={onClose} style={{ position: "absolute", inset: 0, backgroundColor: "rgba(2, 6, 23, 0.55)" }} />
      <aside
        role="dialog"
        aria-label="Case history"
        style={{
          position: "relative",
          width: "min(560px, 100vw)",
          height: "100%",
          backgroundColor: "#0b1120",
          borderLeft: "1px solid #1e293b",
          display: "flex",
          flexDirection: "column",
          boxShadow: "-12px 0 32px rgba(0,0,0,0.4)",
        }}
      >
        <div style={{ padding: "14px 16px", borderBottom: "1px solid #1e293b", display: "flex", gap: "10px", alignItems: "flex-start" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: "10px", fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.04em" }}>Case history</div>
            {data ? (
              <>
                <div style={{ fontSize: "15px", fontWeight: 700, color: "#f1f5f9", marginTop: 2 }}>
                  <span style={{ fontFamily: "'JetBrains Mono', 'Fira Code', monospace", color: "#7dd3fc", marginRight: 8, fontSize: "13px" }}>{data.case.external_id}</span>
                  {data.case.title}
                </div>
                <div style={{ fontSize: "11px", color: "#64748b", marginTop: 2 }}>
                  {[data.case.suite_path, data.case.priority, data.case.execution_type, data.case.version_status].filter(Boolean).join(" · ")}
                </div>
              </>
            ) : null}
          </div>
          <button style={buttonStyle} onClick={() => onOpenInSpec(caseId)} title="Open this case in Specification mode">
            Open in Spec
          </button>
          <button onClick={onClose} aria-label="Close" style={{ background: "none", border: "none", color: "#94a3b8", fontSize: "20px", cursor: "pointer", lineHeight: 1 }}>
            ×
          </button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "14px 16px", display: "flex", flexDirection: "column", gap: "12px" }}>
          {error && <ErrorNote message={error} />}
          {!data && !error && <Loading />}
          {data && (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "8px" }}>
                <Kpi label="Pass rate" value={pct(data.stats.pass_rate)} hint={`over ${data.stats.runs} run${data.stats.runs === 1 ? "" : "s"}`} />
                <Kpi
                  label="Current streak"
                  value={streak ? `${streak.runs}×` : "—"}
                  hint={streak ? <VerdictPill verdict={streak.verdict} /> : "Never executed"}
                />
                <Kpi label="Results" value={data.stats.total_executions} hint={`last ${fmtWhen(data.stats.last_executed_at)}`} />
              </div>
              <div style={{ fontSize: "11px", color: "#94a3b8", display: "flex", gap: "14px", flexWrap: "wrap" }}>
                <span>Last passed: {fmtWhen(data.stats.last_passed_at)}</span>
                <span>Last failed: {fmtWhen(data.stats.last_failed_at)}</span>
                <button
                  style={{ ...buttonStyle, marginLeft: "auto" }}
                  onClick={() => downloadReportCsv(projectId, "case_history", { case_id: caseId, limit: 200 }, `history-${data.case.external_id}.csv`)}
                >
                  CSV
                </button>
              </div>

              {data.executions.length === 0 ? (
                <div style={{ fontSize: "12px", color: "#64748b" }}>This case has never been executed.</div>
              ) : (
                <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "8px" }}>
                  {data.executions.map((e) => {
                    const error = e.failure_message || (e.verdict !== "PASSED" ? e.notes : null);
                    const traceOpen = openTraces.has(e.execution_id);
                    return (
                      <li key={e.execution_id} style={{ backgroundColor: "#0f172a", border: "1px solid #1e293b", borderRadius: "6px", padding: "8px 10px" }}>
                        <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                          <VerdictPill verdict={e.verdict} />
                          <span style={{ fontSize: "12px", color: "#e2e8f0", fontWeight: 600 }}>{e.run.name}</span>
                          <span style={{ fontSize: "11px", color: "#64748b" }}>
                            {e.plan.name}
                            {e.version_number ? ` · v${e.version_number}` : ""}
                          </span>
                          <span style={{ fontSize: "11px", color: "#64748b", marginLeft: "auto" }}>{fmtWhen(e.executed_at)}</span>
                        </div>
                        <div style={{ fontSize: "11px", color: "#94a3b8", marginTop: 4, display: "flex", gap: "10px", flexWrap: "wrap" }}>
                          <span>
                            {e.source === "API" ? "🤖" : "👤"} {e.tested_by}
                          </span>
                          {e.duration_ms !== null && <span>{fmtMs(e.duration_ms)}</span>}
                          {e.runner?.commit_sha && <code style={{ color: "#94a3b8" }}>{e.runner.commit_sha.slice(0, 12)}</code>}
                          {e.runner?.url && (
                            <a href={e.runner.url} target="_blank" rel="noreferrer" style={{ color: "#7dd3fc" }}>
                              {e.runner.name || "CI run"} ↗
                            </a>
                          )}
                          {e.environment && <span>{Object.entries(e.environment).map(([k, v]) => `${k}=${v}`).join(", ")}</span>}
                        </div>
                        {error && <div style={{ fontSize: "12px", color: "#fca5a5", marginTop: 4, wordBreak: "break-word" }}>{error}</div>}
                        {e.notes && e.notes !== error && <div style={{ fontSize: "12px", color: "#cbd5e1", marginTop: 4, wordBreak: "break-word" }}>{e.notes}</div>}
                        {e.stack_trace && (
                          <>
                            <button
                              onClick={() =>
                                setOpenTraces((s) => {
                                  const next = new Set(s);
                                  if (next.has(e.execution_id)) next.delete(e.execution_id);
                                  else next.add(e.execution_id);
                                  return next;
                                })
                              }
                              style={{ ...buttonStyle, marginTop: 6, padding: "2px 8px", fontSize: "10px" }}
                            >
                              {traceOpen ? "Hide" : "Show"} stack trace
                            </button>
                            {traceOpen && (
                              <pre style={{ fontSize: "11px", color: "#cbd5e1", backgroundColor: "#020617", padding: "8px", borderRadius: "4px", overflowX: "auto", margin: "6px 0 0", whiteSpace: "pre" }}>
                                {e.stack_trace}
                              </pre>
                            )}
                          </>
                        )}
                      </li>
                    );
                  })}
                </ol>
              )}
              {data.next_cursor && (
                <button style={{ ...buttonStyle, alignSelf: "center" }} onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? "Loading…" : "Load older results"}
                </button>
              )}
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
