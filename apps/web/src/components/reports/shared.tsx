import React from "react";

/**
 * Shared pieces of the Reports view. Every number shown comes from the report API
 * (POST /api/v1/projects/:projectId/reports/:reportId) -- the same engine agents and
 * scripts use -- so nothing is recomputed here.
 */

export type ReportFormat = "json" | "markdown" | "csv";

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("auth_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Runs a report. JSON comes back parsed; markdown/csv as text. Throws with the server's message. */
export async function runReport<T = any>(projectId: string, reportId: string, params: Record<string, unknown>, format: ReportFormat = "json"): Promise<T> {
  const res = await fetch(`/api/v1/projects/${projectId}/reports/${reportId}${format === "json" ? "" : `?format=${format}`}`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      message = body.message || body.detail || body.error || message;
    } catch {
      // non-JSON error body
    }
    if (res.status === 401) message = "Your session has expired -- sign in again.";
    throw new Error(message);
  }
  return (format === "json" ? await res.json() : await res.text()) as T;
}

/** Downloads a report's CSV form. */
export async function downloadReportCsv(projectId: string, reportId: string, params: Record<string, unknown>, filename: string) {
  const text = await runReport<string>(projectId, reportId, params, "csv");
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Loads a report whenever its inputs change; ignores responses for superseded inputs. */
export function useReport<T>(projectId: string, reportId: string, params: Record<string, unknown> | null) {
  const [data, setData] = React.useState<T | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [reloadTick, setReloadTick] = React.useState(0);
  const key = params ? JSON.stringify(params) : null;
  React.useEffect(() => {
    if (!projectId || key === null) {
      setData(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    runReport<T>(projectId, reportId, JSON.parse(key))
      .then((d) => !cancelled && setData(d))
      .catch((e) => {
        if (cancelled) return;
        setData(null);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [projectId, reportId, key, reloadTick]);
  return { data, error, loading, reload: () => setReloadTick((t) => t + 1) };
}

// ---------------------------------------------------------------------------------------
// Report payload shapes (mirroring @testify/core's report types -- the web app doesn't
// depend on @testify/core).

export interface CaseRef {
  test_case_id: string;
  external_id: string;
  title: string;
  suite_path: string | null;
}

export interface VerdictSummary {
  total: number;
  passed: number;
  failed: number;
  blocked: number;
  skipped: number;
  untested: number;
  other: number;
  pass_rate: number;
  completion: number;
}

export interface RunRef {
  id: string;
  name: string;
  status: string;
  created_at: string;
  release_date: string | null;
  plan_id: string;
  plan_name: string;
}

// ---------------------------------------------------------------------------------------
// Formatting

export const VERDICT_COLORS: Record<string, string> = {
  PASSED: "#22c55e",
  FAILED: "#ef4444",
  BLOCKED: "#f59e0b",
  SKIPPED: "#a855f7",
  UNTESTED: "#475569",
  OTHER: "#64748b",
};

export function verdictColor(v: string | null | undefined): string {
  return VERDICT_COLORS[v ?? "UNTESTED"] ?? VERDICT_COLORS.OTHER;
}

export const pct = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${Math.round(n * 1000) / 10}%`);

export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} m ${Math.round((ms % 60_000) / 1000)} s`;
}

export function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// ---------------------------------------------------------------------------------------
// Styles & small components

export const cardStyle: React.CSSProperties = {
  backgroundColor: "#0f172a",
  border: "1px solid #1e293b",
  borderRadius: "8px",
  padding: "14px 16px",
  minWidth: 0,
};

export const thStyle: React.CSSProperties = {
  textAlign: "left",
  fontSize: "10px",
  fontWeight: 700,
  color: "#64748b",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  padding: "6px 8px",
  borderBottom: "1px solid #1e293b",
  whiteSpace: "nowrap",
};

export const tdStyle: React.CSSProperties = {
  fontSize: "12px",
  color: "#cbd5e1",
  padding: "6px 8px",
  borderBottom: "1px solid #131c2e",
  verticalAlign: "top",
};

export const buttonStyle: React.CSSProperties = {
  padding: "5px 10px",
  backgroundColor: "transparent",
  border: "1px solid #334155",
  borderRadius: "4px",
  color: "#cbd5e1",
  fontSize: "11px",
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

export const selectStyle: React.CSSProperties = {
  backgroundColor: "#0f172a",
  border: "1px solid #334155",
  borderRadius: "4px",
  color: "#e2e8f0",
  fontSize: "12px",
  padding: "4px 6px",
};

export const darkTooltip = {
  contentStyle: { backgroundColor: "#1e293b", border: "1px solid #334155", fontSize: "11px", borderRadius: "4px" },
  labelStyle: { color: "#e2e8f0", fontWeight: 700 },
  itemStyle: { color: "#e2e8f0" },
  cursor: { fill: "rgba(148, 163, 184, 0.08)" },
};

export function Section({ title, subtitle, actions, children }: { title: string; subtitle?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section style={cardStyle}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: "12px", marginBottom: "10px" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 style={{ margin: 0, fontSize: "13px", fontWeight: 700, color: "#e2e8f0" }}>{title}</h3>
          {subtitle && <div style={{ fontSize: "11px", color: "#64748b", marginTop: "2px" }}>{subtitle}</div>}
        </div>
        {actions && <div style={{ display: "flex", gap: "6px", flexShrink: 0, flexWrap: "wrap" }}>{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export function Kpi({ label, value, hint, color }: { label: string; value: React.ReactNode; hint?: React.ReactNode; color?: string }) {
  return (
    <div style={{ ...cardStyle, padding: "10px 14px" }}>
      <div style={{ fontSize: "10px", fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.04em" }}>{label}</div>
      <div style={{ fontSize: "22px", fontWeight: 700, color: color ?? "#f1f5f9", marginTop: "2px", fontVariantNumeric: "tabular-nums" }}>{value}</div>
      {hint && <div style={{ fontSize: "11px", color: "#64748b", marginTop: "2px" }}>{hint}</div>}
    </div>
  );
}

export function VerdictPill({ verdict }: { verdict: string | null | undefined }) {
  const v = verdict ?? "UNTESTED";
  const color = verdictColor(v);
  return (
    <span
      style={{
        display: "inline-block",
        padding: "1px 6px",
        borderRadius: "3px",
        fontSize: "10px",
        fontWeight: 700,
        color,
        border: `1px solid ${color}`,
        backgroundColor: `${color}1f`,
        whiteSpace: "nowrap",
      }}
    >
      {v}
    </span>
  );
}

/** Horizontal stacked bar of verdict counts. */
export function VerdictBar({ summary, height = 8 }: { summary: VerdictSummary; height?: number }) {
  const parts: Array<[string, number]> = [
    ["PASSED", summary.passed],
    ["FAILED", summary.failed],
    ["BLOCKED", summary.blocked],
    ["SKIPPED", summary.skipped],
    ["OTHER", summary.other],
    ["UNTESTED", summary.untested],
  ];
  if (summary.total === 0) return <div style={{ height, borderRadius: height / 2, backgroundColor: "#1e293b" }} />;
  return (
    <div style={{ display: "flex", height, borderRadius: height / 2, overflow: "hidden", backgroundColor: "#1e293b" }}>
      {parts
        .filter(([, n]) => n > 0)
        .map(([v, n]) => (
          <div key={v} title={`${v}: ${n}`} style={{ width: `${(n / summary.total) * 100}%`, backgroundColor: verdictColor(v) }} />
        ))}
    </div>
  );
}

export function VerdictCounts({ summary }: { summary: VerdictSummary }) {
  const items: Array<[string, number]> = [
    ["PASSED", summary.passed],
    ["FAILED", summary.failed],
    ["BLOCKED", summary.blocked],
    ["SKIPPED", summary.skipped],
    ["UNTESTED", summary.untested],
  ];
  if (summary.other) items.push(["OTHER", summary.other]);
  return (
    <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", fontSize: "11px", color: "#94a3b8" }}>
      {items.map(([v, n]) => (
        <span key={v}>
          <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, backgroundColor: verdictColor(v), marginRight: 4 }} />
          {n} {v.toLowerCase()}
        </span>
      ))}
    </div>
  );
}

/** A case reference that opens its history. */
export function CaseCell({ c, onOpen, badge }: { c: CaseRef; onOpen: (caseId: string) => void; badge?: React.ReactNode }) {
  return (
    <button
      onClick={() => onOpen(c.test_case_id)}
      title={c.suite_path ? `${c.suite_path}\nOpen case history` : "Open case history"}
      style={{ background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left", color: "inherit", font: "inherit", display: "flex", gap: "8px", alignItems: "baseline", minWidth: 0, maxWidth: "100%" }}
    >
      <span style={{ fontFamily: "'JetBrains Mono', 'Fira Code', monospace", fontSize: "11px", color: "#7dd3fc", flexShrink: 0 }}>{c.external_id}</span>
      <span style={{ color: "#e2e8f0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.title}</span>
      {badge}
    </button>
  );
}

export function FlakyBadge() {
  return (
    <span title="Flip-flops between pass and fail across runs, or passed only on retry" style={{ fontSize: "10px", fontWeight: 700, color: "#fbbf24", border: "1px solid #92400e", borderRadius: "3px", padding: "0 4px", flexShrink: 0 }}>
      flaky
    </span>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: "12px", color: "#64748b", padding: "8px 0" }}>{children}</div>;
}

export function ErrorNote({ message }: { message: string }) {
  return <div style={{ fontSize: "12px", color: "#f87171", padding: "8px 0" }}>⚠️ {message}</div>;
}

export function Loading() {
  return <div style={{ fontSize: "12px", color: "#64748b", padding: "8px 0" }}>Loading…</div>;
}
