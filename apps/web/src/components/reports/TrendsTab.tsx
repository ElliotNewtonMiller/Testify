import React from "react";
import { ResponsiveContainer, ComposedChart, BarChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from "recharts";
import type { CaseFilterField } from "../CaseFilterPanel";
import {
  Empty,
  ErrorNote,
  Loading,
  Section,
  VERDICT_COLORS,
  buttonStyle,
  darkTooltip,
  downloadReportCsv,
  pct,
  selectStyle,
  tdStyle,
  thStyle,
  useReport,
  useEmailContext,
  type EmailContext,
  type VerdictSummary,
} from "./shared";

interface TrendReport {
  plan: { id: string; name: string };
  points: Array<VerdictSummary & { run_id: string; run_name: string; status: string; created_at: string; new_failures: number | null; fixed: number | null }>;
}

interface BreakdownReport {
  mode: "coverage" | "verdicts";
  group_by: { key: string; label: string };
  run: { id: string; name: string } | null;
  groups: Array<{ key: string } & Partial<VerdictSummary> & { total_cases?: number; in_plan?: number; not_in_plan?: number; coverage?: number }>;
}

const BUILTIN_GROUPS = [
  { key: "suite", label: "Suite" },
  { key: "priority", label: "Priority" },
  { key: "execution_type", label: "Execution type" },
  { key: "version_status", label: "Status" },
  { key: "tester", label: "Tester (needs a run)" },
];

/** How a plan moves across runs, and how groups of cases compare. */
export function TrendsTab({
  projectId,
  planId,
  runId,
  runName,
  fields,
  filter,
  onEmailContext,
}: {
  projectId: string;
  planId: string;
  runId: string;
  runName: string | null;
  fields: CaseFilterField[];
  filter: Record<string, unknown> | null;
  onEmailContext?: (ctx: EmailContext | null) => void;
}) {
  const [runs, setRuns] = React.useState(10);
  const [groupBy, setGroupBy] = React.useState("suite");
  const [useRun, setUseRun] = React.useState(true);

  const trendParams = React.useMemo(() => (planId ? { plan_id: planId, runs, ...(filter ? { filter } : {}) } : null), [planId, runs, filter]);
  const trend = useReport<TrendReport>(projectId, "plan_trend", trendParams);

  const withRun = useRun && Boolean(runId);
  const breakdownParams = React.useMemo(
    () => (planId ? { plan_id: planId, group_by: groupBy, ...(withRun ? { run_id: runId } : {}), ...(filter ? { filter } : {}) } : null),
    [planId, groupBy, withRun, runId, filter]
  );
  const breakdown = useReport<BreakdownReport>(projectId, "breakdown", groupBy === "tester" && !withRun ? null : breakdownParams);
  const groupLabel = BUILTIN_GROUPS.find((g) => g.key === groupBy)?.label.replace(/ \(.*\)$/, "").toLowerCase() ?? fields.find((f) => f.key === groupBy)?.label ?? groupBy;
  useEmailContext(
    onEmailContext,
    trendParams
      ? {
          what: `Plan trend (last ${runs} runs) and breakdown by ${groupLabel}${filter ? ", limited to your filter" : ""}`,
          sections: [{ report_id: "plan_trend", params: trendParams }, ...(breakdownParams && !(groupBy === "tester" && !withRun) ? [{ report_id: "breakdown", params: breakdownParams }] : [])],
        }
      : null
  );

  const customGroups = fields.filter((f) => f.source !== "builtin");

  if (!planId) return <Empty>Pick a test plan in the header to see its trend.</Empty>;

  const chartData = (trend.data?.points ?? []).map((p) => ({ ...p, pass_rate_pct: Math.round(p.pass_rate * 1000) / 10 }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <Section
        title="Plan trend"
        info="Final result counts per run (bars) and pass rate (line), oldest run first. A case's final result is its latest one in that run."
        actions={
          <>
            <select value={runs} onChange={(e) => setRuns(Number(e.target.value))} style={selectStyle}>
              {[5, 10, 20, 50].map((n) => (
                <option key={n} value={n}>
                  Last {n} runs
                </option>
              ))}
            </select>
            {trendParams && (
              <button style={buttonStyle} onClick={() => downloadReportCsv(projectId, "plan_trend", trendParams, "plan-trend.csv")}>
                CSV
              </button>
            )}
          </>
        }
      >
        {trend.error ? (
          <ErrorNote message={trend.error} />
        ) : !trend.data ? (
          <Loading />
        ) : chartData.length === 0 ? (
          <Empty>This plan has no runs yet.</Empty>
        ) : (
          <>
            <div style={{ height: 260 }}>
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                  <XAxis dataKey="run_name" tick={{ fill: "#64748b", fontSize: 10 }} />
                  <YAxis yAxisId="count" allowDecimals={false} tick={{ fill: "#64748b", fontSize: 10 }} />
                  <YAxis yAxisId="rate" orientation="right" domain={[0, 100]} tickFormatter={(v: number) => `${v}%`} tick={{ fill: "#64748b", fontSize: 10 }} />
                  <Tooltip {...darkTooltip} formatter={(value: number, name: string) => (name === "Pass rate" ? [`${value}%`, name] : [value, name])} />
                  <Legend wrapperStyle={{ fontSize: "11px" }} />
                  <Bar yAxisId="count" dataKey="passed" name="Passed" stackId="v" fill={VERDICT_COLORS.PASSED} />
                  <Bar yAxisId="count" dataKey="failed" name="Failed" stackId="v" fill={VERDICT_COLORS.FAILED} />
                  <Bar yAxisId="count" dataKey="blocked" name="Blocked" stackId="v" fill={VERDICT_COLORS.BLOCKED} />
                  <Bar yAxisId="count" dataKey="skipped" name="Skipped" stackId="v" fill={VERDICT_COLORS.SKIPPED} />
                  <Bar yAxisId="count" dataKey="untested" name="Untested" stackId="v" fill={VERDICT_COLORS.UNTESTED} />
                  <Line yAxisId="rate" type="monotone" dataKey="pass_rate_pct" name="Pass rate" stroke="#38bdf8" strokeWidth={2} dot={{ r: 3 }} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <div style={{ overflowX: "auto", marginTop: "8px" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    {["Run", "Pass rate", "Executed", "Failing", "New failures", "Fixed"].map((h) => (
                      <th key={h} style={thStyle}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...chartData].reverse().map((p) => (
                    <tr key={p.run_id}>
                      <td style={tdStyle}>
                        {p.run_name}
                        {p.status === "CLOSED" && <span style={{ color: "#64748b" }}> · closed</span>}
                      </td>
                      <td style={tdStyle}>{pct(p.pass_rate)}</td>
                      <td style={tdStyle}>
                        {p.total - p.untested} / {p.total}
                      </td>
                      <td style={{ ...tdStyle, color: p.failed + p.blocked > 0 ? "#fca5a5" : undefined }}>{p.failed + p.blocked}</td>
                      <td style={{ ...tdStyle, color: p.new_failures ? "#f87171" : undefined }}>{p.new_failures ?? "—"}</td>
                      <td style={{ ...tdStyle, color: p.fixed ? "#4ade80" : undefined }}>{p.fixed ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Section>

      <Section
        title="Breakdown"
        subtitle={withRun ? `Run: ${runName ?? ""}` : "Plan coverage"}
        info={withRun ? "Results of the selected run, per group of cases." : "Plan coverage per group: how many of the group's cases are in the plan."}
        actions={
          <>
            <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)} style={selectStyle} aria-label="Group by">
              <optgroup label="Built-in">
                {BUILTIN_GROUPS.map((g) => (
                  <option key={g.key} value={g.key}>
                    By {g.label.toLowerCase()}
                  </option>
                ))}
              </optgroup>
              {customGroups.some((f) => f.source === "case_custom_field") && (
                <optgroup label="Case fields">
                  {customGroups
                    .filter((f) => f.source === "case_custom_field")
                    .map((f) => (
                      <option key={f.key} value={f.key}>
                        By {f.label}
                      </option>
                    ))}
                </optgroup>
              )}
              {customGroups.some((f) => f.source === "suite_custom_field") && (
                <optgroup label="Suite fields">
                  {customGroups
                    .filter((f) => f.source === "suite_custom_field")
                    .map((f) => (
                      <option key={f.key} value={f.key}>
                        By {f.label}
                      </option>
                    ))}
                </optgroup>
              )}
            </select>
            <select value={useRun ? "run" : "coverage"} onChange={(e) => setUseRun(e.target.value === "run")} style={selectStyle} aria-label="Measure">
              <option value="run" disabled={!runId}>
                Results of the selected run
              </option>
              <option value="coverage">Plan coverage</option>
            </select>
            {breakdownParams && !(groupBy === "tester" && !withRun) && (
              <button style={buttonStyle} onClick={() => downloadReportCsv(projectId, "breakdown", breakdownParams, `breakdown-${groupBy}.csv`)}>
                CSV
              </button>
            )}
          </>
        }
      >
        {groupBy === "tester" && !withRun ? (
          <Empty>Grouping by tester needs a run -- pick "Results of the selected run".</Empty>
        ) : breakdown.error ? (
          <ErrorNote message={breakdown.error} />
        ) : !breakdown.data ? (
          <Loading />
        ) : breakdown.data.groups.length === 0 ? (
          <Empty>No cases to group.</Empty>
        ) : (
          <BreakdownBody report={breakdown.data} />
        )}
      </Section>
    </div>
  );
}

const LABEL_FONT_PX = 11;
/** Rough width of one character at 11px -- enough to size the label column and decide
 * where to cut a label, without measuring text in the DOM. */
const LABEL_CHAR_PX = 6.3;
const ROW_PX = 32;

/** One-line Y-axis label: long group names (e.g. nested suite paths) are cut with "…" instead
 * of wrapping into the neighbouring rows; the full name shows on hover. */
function GroupTick({ x, y, payload, width }: { x?: number; y?: number; payload?: { value: string }; width: number }) {
  const full = String(payload?.value ?? "");
  const maxChars = Math.max(4, Math.floor((width - 8) / LABEL_CHAR_PX));
  // For paths, keep the end ("… / Child suite") -- it's the part that tells rows apart.
  const label = full.length <= maxChars ? full : full.includes(" / ") ? `…${full.slice(full.length - maxChars + 1)}` : `${full.slice(0, maxChars - 1)}…`;
  return (
    <text x={x} y={y} dy={4} textAnchor="end" fill="#cbd5e1" fontSize={LABEL_FONT_PX}>
      <title>{full}</title>
      {label}
    </text>
  );
}

function BreakdownBody({ report }: { report: BreakdownReport }) {
  const verdicts = report.mode === "verdicts";
  const height = Math.max(120, report.groups.length * ROW_PX + 40);
  // Fit the longest label, within 100-280px, so short labels don't waste room and long ones
  // don't squeeze the bars.
  const longest = report.groups.reduce((n, g) => Math.max(n, String(g.key).length), 0);
  const labelWidth = Math.min(280, Math.max(100, Math.ceil(longest * LABEL_CHAR_PX) + 12));
  return (
    <>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={report.groups} layout="vertical" margin={{ top: 0, right: 8, left: 8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" horizontal={false} />
            <XAxis type="number" allowDecimals={false} tick={{ fill: "#64748b", fontSize: 10 }} />
            <YAxis type="category" dataKey="key" width={labelWidth} interval={0} tick={<GroupTick width={labelWidth} />} />
            <Tooltip {...darkTooltip} />
            <Legend wrapperStyle={{ fontSize: "11px" }} />
            {verdicts ? (
              <>
                <Bar dataKey="passed" name="Passed" stackId="g" fill={VERDICT_COLORS.PASSED} />
                <Bar dataKey="failed" name="Failed" stackId="g" fill={VERDICT_COLORS.FAILED} />
                <Bar dataKey="blocked" name="Blocked" stackId="g" fill={VERDICT_COLORS.BLOCKED} />
                <Bar dataKey="skipped" name="Skipped" stackId="g" fill={VERDICT_COLORS.SKIPPED} />
                <Bar dataKey="untested" name="Untested" stackId="g" fill={VERDICT_COLORS.UNTESTED} />
              </>
            ) : (
              <>
                <Bar dataKey="in_plan" name="In plan" stackId="g" fill="#0ea5e9" />
                <Bar dataKey="not_in_plan" name="Not in plan" stackId="g" fill="#334155" />
              </>
            )}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div style={{ overflowX: "auto", marginTop: "8px" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={thStyle}>{report.group_by.label}</th>
              {verdicts
                ? ["Cases", "Pass rate", "Executed", "Passed", "Failed", "Blocked", "Untested"].map((h) => (
                    <th key={h} style={thStyle}>
                      {h}
                    </th>
                  ))
                : ["Cases", "In plan", "Not in plan", "Coverage"].map((h) => (
                    <th key={h} style={thStyle}>
                      {h}
                    </th>
                  ))}
            </tr>
          </thead>
          <tbody>
            {report.groups.map((g) => (
              <tr key={g.key}>
                <td style={tdStyle}>{g.key}</td>
                {verdicts ? (
                  <>
                    <td style={tdStyle}>{g.total}</td>
                    <td style={tdStyle}>{pct(g.pass_rate)}</td>
                    <td style={tdStyle}>{pct(g.completion)}</td>
                    <td style={tdStyle}>{g.passed}</td>
                    <td style={{ ...tdStyle, color: g.failed ? "#fca5a5" : undefined }}>{g.failed}</td>
                    <td style={{ ...tdStyle, color: g.blocked ? "#fcd34d" : undefined }}>{g.blocked}</td>
                    <td style={tdStyle}>{g.untested}</td>
                  </>
                ) : (
                  <>
                    <td style={tdStyle}>{g.total_cases}</td>
                    <td style={tdStyle}>{g.in_plan}</td>
                    <td style={tdStyle}>{g.not_in_plan}</td>
                    <td style={tdStyle}>{pct(g.coverage)}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
