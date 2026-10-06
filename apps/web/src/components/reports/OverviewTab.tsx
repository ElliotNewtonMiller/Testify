import React from "react";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from "recharts";
import {
  CaseCell,
  Empty,
  ErrorNote,
  Kpi,
  Loading,
  Section,
  VerdictBar,
  VerdictCounts,
  darkTooltip,
  pct,
  selectStyle,
  useReport,
  type CaseRef,
  type RunRef,
  type VerdictSummary,
} from "./shared";

interface OverviewReport {
  plans: Array<{
    plan: { id: string; name: string };
    latest_run: RunRef | null;
    previous_run: { id: string; name: string } | null;
    summary: VerdictSummary | null;
    new_failures: number | null;
    fixed: number | null;
  }>;
  spec: {
    total_cases: number;
    by_status: Record<string, number>;
    drafts_awaiting_approval: number;
    oldest_drafts: Array<CaseRef & { version_number: number; waiting_days: number }>;
    never_executed: number;
  };
  activity: { days: number; total: number; ui: number; api: number; by_day: Array<{ day: string; ui: number; api: number; total: number }> };
}

/** Stakeholder view: every active plan's latest run, spec health, and testing activity. */
export function OverviewTab({ projectId, onOpenRun, onOpenCase }: { projectId: string; onOpenRun: (planId: string) => void; onOpenCase: (caseId: string) => void }) {
  const [days, setDays] = React.useState(30);
  const { data, error, loading } = useReport<OverviewReport>(projectId, "overview", { days });

  if (error) return <ErrorNote message={error} />;
  if (!data) return loading ? <Loading /> : null;

  const s = data.spec;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <Section title="Active test plans" info="Latest run of each active plan, compared with the run before it. Click a plan to open its run summary.">
        {data.plans.length === 0 ? (
          <Empty>No active test plans in this project.</Empty>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "10px" }}>
            {data.plans.map((p) => (
              <button
                key={p.plan.id}
                onClick={() => p.latest_run && onOpenRun(p.plan.id)}
                disabled={!p.latest_run}
                style={{
                  textAlign: "left",
                  backgroundColor: "#111827",
                  border: "1px solid #1e293b",
                  borderRadius: "6px",
                  padding: "12px",
                  cursor: p.latest_run ? "pointer" : "default",
                  color: "inherit",
                  font: "inherit",
                }}
              >
                <div style={{ fontSize: "13px", fontWeight: 700, color: "#e2e8f0" }}>{p.plan.name}</div>
                {!p.latest_run || !p.summary ? (
                  <Empty>No runs yet.</Empty>
                ) : (
                  <>
                    <div style={{ fontSize: "11px", color: "#64748b", margin: "2px 0 8px" }}>
                      {p.latest_run.name}
                      {p.latest_run.status === "CLOSED" ? " · closed" : ""}
                    </div>
                    <div style={{ display: "flex", alignItems: "baseline", gap: "10px", marginBottom: "6px" }}>
                      <span style={{ fontSize: "24px", fontWeight: 700, color: "#f1f5f9" }}>{pct(p.summary.pass_rate)}</span>
                      <span style={{ fontSize: "11px", color: "#94a3b8" }}>pass rate · {pct(p.summary.completion)} executed</span>
                    </div>
                    <VerdictBar summary={p.summary} />
                    <div style={{ display: "flex", gap: "10px", marginTop: "8px", fontSize: "11px" }}>
                      {p.new_failures !== null ? (
                        <>
                          <span style={{ color: p.new_failures > 0 ? "#f87171" : "#64748b", fontWeight: p.new_failures > 0 ? 700 : 400 }}>
                            {p.new_failures} new failure{p.new_failures === 1 ? "" : "s"}
                          </span>
                          <span style={{ color: p.fixed ? "#4ade80" : "#64748b" }}>{p.fixed} fixed</span>
                        </>
                      ) : (
                        <span style={{ color: "#64748b" }}>First run of this plan</span>
                      )}
                    </div>
                  </>
                )}
              </button>
            ))}
          </div>
        )}
      </Section>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "10px" }}>
        <Kpi label="Test cases" value={s.total_cases} hint={`${s.by_status.APPROVED ?? 0} approved · ${s.by_status.DEPRECATED ?? 0} deprecated`} />
        <Kpi label="Drafts awaiting approval" value={s.drafts_awaiting_approval} info="Draft versions not yet approved -- they can't run in a plan until they are." color={s.drafts_awaiting_approval > 0 ? "#fbbf24" : undefined} />
        <Kpi label="Never executed" value={s.never_executed} info="Live (non-deprecated) cases with no result in any run of any plan." />
        <Kpi label={`Results, last ${data.activity.days} days`} value={data.activity.total} hint={`${data.activity.api} automated · ${data.activity.ui} by people`} />
      </div>

      <Section
        title="Testing activity"
        info="Results recorded per day: automated (API) vs. by people (UI)."
        actions={
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={selectStyle}>
            {[7, 14, 30, 90].map((d) => (
              <option key={d} value={d}>
                Last {d} days
              </option>
            ))}
          </select>
        }
      >
        <div style={{ height: 200 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data.activity.by_day} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
              <XAxis dataKey="day" tick={{ fill: "#64748b", fontSize: 10 }} tickFormatter={(d: string) => d.slice(5)} />
              <YAxis allowDecimals={false} tick={{ fill: "#64748b", fontSize: 10 }} />
              <Tooltip {...darkTooltip} />
              <Legend wrapperStyle={{ fontSize: "11px" }} />
              <Bar dataKey="api" name="Automated" stackId="a" fill="#0ea5e9" />
              <Bar dataKey="ui" name="By people" stackId="a" fill="#a78bfa" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Section>

      {s.oldest_drafts.length > 0 && (
        <Section title="Drafts waiting longest" info="Draft versions not yet approved -- they can't run in a plan until they are. Longest-waiting first.">
          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            {s.oldest_drafts.map((d) => (
              <div key={d.test_case_id} style={{ display: "flex", gap: "10px", alignItems: "baseline", fontSize: "12px" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <CaseCell c={d} onOpen={onOpenCase} />
                </div>
                <span style={{ color: "#64748b", fontSize: "11px", flexShrink: 0 }}>
                  v{d.version_number} · {d.waiting_days === 0 ? "today" : `${d.waiting_days} day${d.waiting_days === 1 ? "" : "s"}`}
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {data.plans.some((p) => p.summary) && (
        <Section title="Latest runs at a glance">
          {data.plans
            .filter((p) => p.summary)
            .map((p) => (
              <div key={p.plan.id} style={{ display: "flex", gap: "12px", alignItems: "center", padding: "4px 0" }}>
                <div style={{ width: 180, fontSize: "12px", color: "#cbd5e1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.plan.name}</div>
                <div style={{ flex: 1 }}>
                  <VerdictCounts summary={p.summary!} />
                </div>
              </div>
            ))}
        </Section>
      )}
    </div>
  );
}
