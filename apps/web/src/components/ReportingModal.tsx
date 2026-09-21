import React, { useEffect, useState } from "react";
import {
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
  Tooltip,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";
import { UserProfile } from "./AuthModal";

interface ProjectItem {
  id: string;
  name: string;
  prefix?: string;
}

interface PlanItem {
  id: string;
  name: string;
}

interface BuildItem {
  id: string;
  name: string;
}

interface ReportingModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: UserProfile | null;
  projects: ProjectItem[];
  defaultProjectId?: string;
}

interface VerdictBreakdown {
  build: { id: string; name: string; plan_id: string; plan_name: string };
  total_cases: number;
  breakdown: Record<string, number>;
}

interface TrendPoint {
  build_id: string;
  build_name: string;
  release_date: string | null;
  total_cases: number;
  passed: number;
  failed: number;
  blocked: number;
  skipped: number;
  untested: number;
  other: number;
  pass_rate: number;
}

interface TrendReport {
  plan: { id: string; name: string };
  builds: TrendPoint[];
}

interface CoverageSuite {
  suite_id: string;
  suite_name: string;
  total_case_count: number;
  in_plan_count: number;
}

interface CoverageReport {
  plan: { id: string; name: string };
  suites: CoverageSuite[];
}

interface TestHealthRow {
  test_case_id: string;
  external_id: string;
  title: string;
  duration_ms?: number;
  total_executions?: number;
  verdict_changes?: number;
  flakiness_rate?: number;
}

interface TestHealthReport {
  scope: { type: string; id: string };
  slowest_tests: TestHealthRow[];
  flakiest_tests: TestHealthRow[];
}

const VERDICT_COLORS: Record<string, string> = {
  PASSED: "#22c55e",
  FAILED: "#ef4444",
  BLOCKED: "#f59e0b",
  SKIPPED: "#a855f7",
  UNTESTED: "#475569",
  OTHER: "#64748b",
};

const selectStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px",
  backgroundColor: "#0f172a",
  border: "1px solid #334155",
  borderRadius: "4px",
  color: "#e2e8f0",
  fontSize: "12px",
  boxSizing: "border-box",
};

const secondaryButtonStyle: React.CSSProperties = {
  padding: "8px 16px",
  backgroundColor: "transparent",
  border: "1px solid #4b5563",
  borderRadius: "4px",
  color: "#9ca3af",
  fontSize: "12px",
  fontWeight: 600,
  cursor: "pointer",
};

const labelStyle: React.CSSProperties = { fontSize: "11px", color: "#94a3b8", fontWeight: 700, display: "block", marginBottom: "4px" };
const helperTextStyle: React.CSSProperties = { fontSize: "10px", color: "#64748b", marginTop: "4px" };

const cardStyle: React.CSSProperties = {
  backgroundColor: "#0f172a",
  border: "1px solid #1e293b",
  borderRadius: "8px",
  padding: "14px",
  display: "flex",
  flexDirection: "column",
  minHeight: "260px",
};

const cardTitleStyle: React.CSSProperties = { fontSize: "13px", fontWeight: 700, color: "#e2e8f0", marginBottom: "8px" };

function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem("auth_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function ReportingModal({ isOpen, onClose, currentUser, projects, defaultProjectId }: ReportingModalProps) {
  const [targetProjectId, setTargetProjectId] = useState<string>("");
  const [plans, setPlans] = useState<PlanItem[]>([]);
  const [selectedPlanId, setSelectedPlanId] = useState<string>("");
  const [builds, setBuilds] = useState<BuildItem[]>([]);
  const [selectedBuildId, setSelectedBuildId] = useState<string>("");

  const [verdictBreakdown, setVerdictBreakdown] = useState<VerdictBreakdown | null>(null);
  const [verdictError, setVerdictError] = useState<string | null>(null);

  const [trend, setTrend] = useState<TrendReport | null>(null);
  const [trendError, setTrendError] = useState<string | null>(null);

  const [coverage, setCoverage] = useState<CoverageReport | null>(null);
  const [coverageError, setCoverageError] = useState<string | null>(null);

  const [testHealth, setTestHealth] = useState<TestHealthReport | null>(null);
  const [testHealthError, setTestHealthError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && !targetProjectId) {
      setTargetProjectId(defaultProjectId || projects[0]?.id || "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, defaultProjectId, projects]);

  useEffect(() => {
    if (!isOpen) return;
    setSelectedPlanId("");
    setSelectedBuildId("");
    setPlans([]);
    setBuilds([]);
  }, [isOpen, targetProjectId]);

  // Plan list for the scope-picker row.
  useEffect(() => {
    if (!(isOpen && targetProjectId)) return;
    (async () => {
      try {
        const res = await fetch(`/api/v1/projects/${targetProjectId}/plans`, { headers: getAuthHeaders() });
        const data = await res.json();
        if (res.ok) setPlans(data.plans || []);
      } catch {
        setPlans([]);
      }
    })();
  }, [isOpen, targetProjectId]);

  // Build list -- resets whenever the plan changes.
  useEffect(() => {
    setSelectedBuildId("");
    setBuilds([]);
    if (!(isOpen && targetProjectId && selectedPlanId)) return;
    (async () => {
      try {
        const res = await fetch(`/api/v1/projects/${targetProjectId}/plans/${selectedPlanId}/builds`, { headers: getAuthHeaders() });
        const data = await res.json();
        if (res.ok) setBuilds(data.builds || []);
      } catch {
        setBuilds([]);
      }
    })();
  }, [isOpen, targetProjectId, selectedPlanId]);

  // Verdict Breakdown -- Build-scoped.
  useEffect(() => {
    setVerdictBreakdown(null);
    setVerdictError(null);
    if (!(isOpen && targetProjectId && selectedBuildId)) return;
    (async () => {
      try {
        const res = await fetch(`/api/v1/projects/${targetProjectId}/reports/verdict-breakdown?build_id=${selectedBuildId}`, {
          headers: getAuthHeaders(),
        });
        const data = await res.json();
        if (res.ok) setVerdictBreakdown(data);
        else setVerdictError(data.error || `Failed (${res.status})`);
      } catch (err: any) {
        setVerdictError(err.message || "Failed to load");
      }
    })();
  }, [isOpen, targetProjectId, selectedBuildId]);

  // Execution Trend -- Plan-scoped, last 10 builds.
  useEffect(() => {
    setTrend(null);
    setTrendError(null);
    if (!(isOpen && targetProjectId && selectedPlanId)) return;
    (async () => {
      try {
        const res = await fetch(`/api/v1/projects/${targetProjectId}/reports/trend?plan_id=${selectedPlanId}&limit=10`, {
          headers: getAuthHeaders(),
        });
        const data = await res.json();
        if (res.ok) setTrend(data);
        else setTrendError(data.error || `Failed (${res.status})`);
      } catch (err: any) {
        setTrendError(err.message || "Failed to load");
      }
    })();
  }, [isOpen, targetProjectId, selectedPlanId]);

  // Coverage by Suite -- Plan-scoped.
  useEffect(() => {
    setCoverage(null);
    setCoverageError(null);
    if (!(isOpen && targetProjectId && selectedPlanId)) return;
    (async () => {
      try {
        const res = await fetch(`/api/v1/projects/${targetProjectId}/reports/coverage?plan_id=${selectedPlanId}`, {
          headers: getAuthHeaders(),
        });
        const data = await res.json();
        if (res.ok) setCoverage(data);
        else setCoverageError(data.error || `Failed (${res.status})`);
      } catch (err: any) {
        setCoverageError(err.message || "Failed to load");
      }
    })();
  }, [isOpen, targetProjectId, selectedPlanId]);

  // Slowest + Flakiest Tests -- Build-scoped if a build is chosen, else the whole Plan.
  useEffect(() => {
    setTestHealth(null);
    setTestHealthError(null);
    const scopeType = selectedBuildId ? "BUILD" : selectedPlanId ? "PLAN" : "";
    const scopeId = selectedBuildId || selectedPlanId;
    if (!(isOpen && targetProjectId && scopeType && scopeId)) return;
    (async () => {
      try {
        const res = await fetch(
          `/api/v1/projects/${targetProjectId}/reports/test-health?scope_type=${scopeType}&scope_id=${scopeId}&limit=10`,
          { headers: getAuthHeaders() }
        );
        const data = await res.json();
        if (res.ok) setTestHealth(data);
        else setTestHealthError(data.error || `Failed (${res.status})`);
      } catch (err: any) {
        setTestHealthError(err.message || "Failed to load");
      }
    })();
  }, [isOpen, targetProjectId, selectedPlanId, selectedBuildId]);

  if (!isOpen) return null;

  const verdictPieData = verdictBreakdown
    ? Object.entries(verdictBreakdown.breakdown)
        .filter(([, count]) => count > 0)
        .map(([verdict, count]) => ({ name: verdict, value: count }))
    : [];

  const coverageChartData = coverage
    ? coverage.suites.map((s) => ({
        name: s.suite_name,
        in_plan: s.in_plan_count,
        not_in_plan: Math.max(s.total_case_count - s.in_plan_count, 0),
      }))
    : [];

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0, 0, 0, 0.8)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        style={{
          width: "960px",
          maxWidth: "95vw",
          maxHeight: "90vh",
          backgroundColor: "#0f172a",
          border: "1px solid #1e293b",
          borderRadius: "10px",
          padding: "24px",
          color: "#f8fafc",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "16px" }}>
          <div>
            <h2 style={{ margin: 0, fontSize: "20px" }}>📊 Reports</h2>
            <div style={{ fontSize: "12px", color: "#94a3b8", marginTop: "4px" }}>
              Verdict breakdown, execution trend, coverage, and test health for this project.
            </div>
          </div>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", color: "#94a3b8", fontSize: "20px", cursor: "pointer", lineHeight: 1 }}
          >
            ✕
          </button>
        </div>

        <div style={{ display: "flex", gap: "12px", marginBottom: "16px" }}>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>PROJECT</label>
            <select value={targetProjectId} onChange={(e) => setTargetProjectId(e.target.value)} style={selectStyle}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>PLAN</label>
            <select value={selectedPlanId} onChange={(e) => setSelectedPlanId(e.target.value)} style={selectStyle}>
              <option value="">Select a plan...</option>
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>BUILD</label>
            <select
              value={selectedBuildId}
              onChange={(e) => setSelectedBuildId(e.target.value)}
              disabled={!selectedPlanId}
              style={selectStyle}
            >
              <option value="">All builds (plan-wide)</option>
              {builds.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div style={{ flex: 1, overflowY: "auto" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>
            <div style={cardStyle}>
              <div style={cardTitleStyle}>Verdict Breakdown {verdictBreakdown ? `— ${verdictBreakdown.build.name}` : ""}</div>
              {!selectedBuildId ? (
                <div style={helperTextStyle}>Select a build to see its verdict breakdown.</div>
              ) : verdictError ? (
                <div style={{ ...helperTextStyle, color: "#fca5a5" }}>{verdictError}</div>
              ) : !verdictBreakdown ? (
                <div style={helperTextStyle}>Loading...</div>
              ) : verdictPieData.length === 0 ? (
                <div style={helperTextStyle}>No cases in this plan.</div>
              ) : (
                <ResponsiveContainer width="100%" height={220}>
                  <PieChart>
                    <Pie data={verdictPieData} dataKey="value" nameKey="name" innerRadius={50} outerRadius={85} paddingAngle={2}>
                      {verdictPieData.map((entry) => (
                        <Cell key={entry.name} fill={VERDICT_COLORS[entry.name] || "#64748b"} />
                      ))}
                    </Pie>
                    <Legend wrapperStyle={{ fontSize: "11px", color: "#e2e8f0" }} />
                    <Tooltip contentStyle={{ backgroundColor: "#1e293b", border: "1px solid #334155", fontSize: "11px" }} />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>

            <div style={cardStyle}>
              <div style={cardTitleStyle}>Execution Trend {trend ? `— ${trend.plan.name}` : ""}</div>
              {!selectedPlanId ? (
                <div style={helperTextStyle}>Select a plan to see its execution trend.</div>
              ) : trendError ? (
                <div style={{ ...helperTextStyle, color: "#fca5a5" }}>{trendError}</div>
              ) : !trend ? (
                <div style={helperTextStyle}>Loading...</div>
              ) : trend.builds.length === 0 ? (
                <div style={helperTextStyle}>No builds in this plan yet.</div>
              ) : (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={trend.builds}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="build_name" tick={{ fontSize: 10, fill: "#94a3b8" }} />
                    <YAxis domain={[0, 1]} tickFormatter={(v) => `${Math.round(v * 100)}%`} tick={{ fontSize: 10, fill: "#94a3b8" }} />
                    <Tooltip
                      contentStyle={{ backgroundColor: "#1e293b", border: "1px solid #334155", fontSize: "11px" }}
                      formatter={(value: number) => `${Math.round(value * 100)}%`}
                    />
                    <Bar dataKey="pass_rate" name="Pass rate" fill="#0ea5e9" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>

            <div style={cardStyle}>
              <div style={cardTitleStyle}>Coverage by Suite {coverage ? `— ${coverage.plan.name}` : ""}</div>
              {!selectedPlanId ? (
                <div style={helperTextStyle}>Select a plan to see coverage by suite.</div>
              ) : coverageError ? (
                <div style={{ ...helperTextStyle, color: "#fca5a5" }}>{coverageError}</div>
              ) : !coverage ? (
                <div style={helperTextStyle}>Loading...</div>
              ) : coverageChartData.length === 0 ? (
                <div style={helperTextStyle}>No suites in this project.</div>
              ) : (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={coverageChartData} layout="vertical" margin={{ left: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis type="number" tick={{ fontSize: 10, fill: "#94a3b8" }} allowDecimals={false} />
                    <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 10, fill: "#94a3b8" }} />
                    <Tooltip contentStyle={{ backgroundColor: "#1e293b", border: "1px solid #334155", fontSize: "11px" }} />
                    <Legend wrapperStyle={{ fontSize: "11px", color: "#e2e8f0" }} />
                    <Bar dataKey="in_plan" stackId="a" name="In plan" fill="#0ea5e9" />
                    <Bar dataKey="not_in_plan" stackId="a" name="Not in plan" fill="#334155" />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>

            <div style={cardStyle}>
              <div style={cardTitleStyle}>Slowest &amp; Flakiest Tests</div>
              {!selectedPlanId ? (
                <div style={helperTextStyle}>Select a plan (and optionally a build) to see test health.</div>
              ) : testHealthError ? (
                <div style={{ ...helperTextStyle, color: "#fca5a5" }}>{testHealthError}</div>
              ) : !testHealth ? (
                <div style={helperTextStyle}>Loading...</div>
              ) : (
                <div style={{ display: "flex", gap: "10px", flex: 1, minHeight: 0 }}>
                  <div style={{ flex: 1, overflowY: "auto" }}>
                    <div style={{ fontSize: "10px", color: "#94a3b8", fontWeight: 700, marginBottom: "4px" }}>SLOWEST</div>
                    {testHealth.slowest_tests.length === 0 ? (
                      <div style={helperTextStyle}>No measured durations yet.</div>
                    ) : (
                      testHealth.slowest_tests.map((t) => (
                        <div key={t.test_case_id} style={{ fontSize: "11px", padding: "3px 0", borderBottom: "1px solid #1e293b" }}>
                          <div style={{ color: "#e2e8f0" }}>{t.external_id}</div>
                          <div style={{ color: "#64748b" }}>{t.duration_ms}ms</div>
                        </div>
                      ))
                    )}
                  </div>
                  <div style={{ flex: 1, overflowY: "auto" }}>
                    <div style={{ fontSize: "10px", color: "#94a3b8", fontWeight: 700, marginBottom: "4px" }}>FLAKIEST</div>
                    {testHealth.flakiest_tests.length === 0 ? (
                      <div style={helperTextStyle}>No flaky tests detected.</div>
                    ) : (
                      testHealth.flakiest_tests.map((t) => (
                        <div key={t.test_case_id} style={{ fontSize: "11px", padding: "3px 0", borderBottom: "1px solid #1e293b" }}>
                          <div style={{ color: "#e2e8f0" }}>{t.external_id}</div>
                          <div style={{ color: "#64748b" }}>
                            {Math.round((t.flakiness_rate || 0) * 100)}% ({t.verdict_changes}/{t.total_executions})
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "16px", paddingTop: "16px", borderTop: "1px solid #1e293b" }}>
          <button onClick={onClose} style={secondaryButtonStyle}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
