import React, { useState, useEffect } from "react";
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

interface SuiteTreeNode {
  id: string;
  name: string;
  children: SuiteTreeNode[];
}

type ExportKind = "DEFINITIONS" | "EXECUTION_RESULTS";
type ExportFormat = "NATIVE_JSON" | "STANDARD_CSV";
type DefinitionsScopeType = "PROJECT" | "SUITE" | "PLAN";
type StatusFilter = "ALL" | "APPROVED_ONLY";

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: UserProfile | null;
  projects: ProjectItem[];
  defaultProjectId?: string;
}

// Flattens the suite tree into an indented option list for the Suite <select>.
function flattenSuites(nodes: SuiteTreeNode[], depth = 0): Array<{ id: string; label: string }> {
  const out: Array<{ id: string; label: string }> = [];
  for (const n of nodes) {
    out.push({ id: n.id, label: `${"— ".repeat(depth)}${n.name}` });
    out.push(...flattenSuites(n.children, depth + 1));
  }
  return out;
}

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

function primaryButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: "8px 16px",
    backgroundColor: disabled ? "#075985" : "#0ea5e9",
    border: "none",
    borderRadius: "4px",
    color: "#fff",
    fontWeight: 600,
    fontSize: "12px",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.8 : 1,
  };
}

function kindToggleStyle(active: boolean): React.CSSProperties {
  return {
    flex: 1,
    padding: "8px 12px",
    borderRadius: "4px",
    fontSize: "12px",
    fontWeight: 700,
    border: active ? "1px solid #0ea5e9" : "1px solid #4b5563",
    backgroundColor: active ? "rgba(14, 165, 233, 0.15)" : "transparent",
    color: active ? "#38bdf8" : "#9ca3af",
    cursor: "pointer",
  };
}

const labelStyle: React.CSSProperties = { fontSize: "11px", color: "#94a3b8", fontWeight: 700, display: "block", marginBottom: "4px" };
const helperTextStyle: React.CSSProperties = { fontSize: "10px", color: "#64748b", marginTop: "4px" };

export function ExportModal({ isOpen, onClose, currentUser, projects, defaultProjectId }: ExportModalProps) {
  const [exportKind, setExportKind] = useState<ExportKind>("DEFINITIONS");
  const [targetProjectId, setTargetProjectId] = useState<string>("");
  const [scopeType, setScopeType] = useState<DefinitionsScopeType>("PROJECT");
  const [suites, setSuites] = useState<SuiteTreeNode[]>([]);
  const [selectedSuiteId, setSelectedSuiteId] = useState<string>("");
  const [plans, setPlans] = useState<PlanItem[]>([]);
  const [selectedPlanId, setSelectedPlanId] = useState<string>("");
  const [builds, setBuilds] = useState<BuildItem[]>([]);
  const [selectedBuildId, setSelectedBuildId] = useState<string>("");
  const [format, setFormat] = useState<ExportFormat>("NATIVE_JSON");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");

  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const getAuthHeaders = (): Record<string, string> => {
    const token = localStorage.getItem("auth_token");
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

  useEffect(() => {
    if (isOpen && !targetProjectId) {
      setTargetProjectId(defaultProjectId || projects[0]?.id || "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, defaultProjectId, projects]);

  useEffect(() => {
    if (!isOpen) {
      setErrorMessage(null);
      setSuccessMessage(null);
    }
  }, [isOpen]);

  // Switching the target project invalidates whatever Plan/Build was selected for the
  // previous one -- without this, the Plan <select> just shows blank (its value won't match
  // any option in the new project's plans list) while selectedPlanId silently keeps pointing
  // at the old, wrong project's plan, so exporting without re-touching that dropdown would
  // use the stale id.
  useEffect(() => {
    if (!isOpen) return;
    setSelectedPlanId("");
    setSelectedBuildId("");
    setPlans([]);
    setBuilds([]);
  }, [isOpen, targetProjectId]);

  // Suite picker data -- reuses the existing spec-tree route's suite list rather than
  // inventing a new endpoint, matching ImportWizardModal's self-contained-fetch pattern.
  useEffect(() => {
    if (!(isOpen && exportKind === "DEFINITIONS" && scopeType === "SUITE" && targetProjectId)) return;
    (async () => {
      try {
        const res = await fetch(`/api/v1/projects/${targetProjectId}/spec-tree`, { headers: getAuthHeaders() });
        const data = await res.json();
        if (res.ok) setSuites(data.suites || []);
      } catch {
        setSuites([]);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, exportKind, scopeType, targetProjectId]);

  // Plan picker data -- needed for DEFINITIONS+PLAN scope, or always for EXECUTION_RESULTS.
  useEffect(() => {
    if (!(isOpen && targetProjectId && (exportKind === "EXECUTION_RESULTS" || (exportKind === "DEFINITIONS" && scopeType === "PLAN")))) return;
    (async () => {
      try {
        const res = await fetch(`/api/v1/projects/${targetProjectId}/plans`, { headers: getAuthHeaders() });
        const data = await res.json();
        if (res.ok) setPlans(data.plans || []);
      } catch {
        setPlans([]);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, exportKind, scopeType, targetProjectId]);

  // Build picker data -- only for EXECUTION_RESULTS, once a plan is chosen. Resets
  // selectedBuildId/builds unconditionally first, whenever this effect re-runs for any
  // reason (plan changed, project changed, kind changed) -- a build is plan-scoped, so a
  // stale selection from a previous plan must never survive into this one.
  useEffect(() => {
    setSelectedBuildId("");
    setBuilds([]);
    if (!(isOpen && exportKind === "EXECUTION_RESULTS" && targetProjectId && selectedPlanId)) return;
    (async () => {
      try {
        const res = await fetch(`/api/v1/projects/${targetProjectId}/plans/${selectedPlanId}/builds`, { headers: getAuthHeaders() });
        const data = await res.json();
        if (res.ok) setBuilds(data.builds || []);
      } catch {
        setBuilds([]);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, exportKind, targetProjectId, selectedPlanId]);

  if (!isOpen) return null;

  const flatSuites = flattenSuites(suites);

  const handleExport = async () => {
    setIsLoading(true);
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      let path: string;
      let payload: Record<string, unknown>;

      if (exportKind === "DEFINITIONS") {
        const scope =
          scopeType === "SUITE"
            ? { type: "SUITE", suite_id: selectedSuiteId }
            : scopeType === "PLAN"
            ? { type: "PLAN", plan_id: selectedPlanId }
            : { type: "PROJECT" };
        path = `/api/v1/projects/${targetProjectId}/exports/definitions`;
        payload = { format, scope, status_filter: statusFilter };
      } else {
        path = `/api/v1/projects/${targetProjectId}/exports/execution-results`;
        payload = { format, plan_id: selectedPlanId, build_id: selectedBuildId };
      }

      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || errBody.detail || `Export failed (${res.status})`);
      }

      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") || "";
      const match = disposition.match(/filename="([^"]+)"/);
      const filename = match?.[1] || `testify_export.${format === "STANDARD_CSV" ? "csv" : "json"}`;

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      setSuccessMessage(`Downloaded ${filename}`);
      setTimeout(() => setSuccessMessage((prev) => (prev === `Downloaded ${filename}` ? null : prev)), 3000);
    } catch (err: any) {
      setErrorMessage(err.message || "Export failed");
    } finally {
      setIsLoading(false);
    }
  };

  const scopeIsReady =
    exportKind === "DEFINITIONS"
      ? (scopeType !== "SUITE" || Boolean(selectedSuiteId)) && (scopeType !== "PLAN" || Boolean(selectedPlanId))
      : Boolean(selectedPlanId && selectedBuildId);
  const canExport = !isLoading && Boolean(targetProjectId) && scopeIsReady;

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
          width: "520px",
          maxHeight: "85vh",
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
            <h2 style={{ margin: 0, fontSize: "20px" }}>📤 Export Data</h2>
            <div style={{ fontSize: "12px", color: "#94a3b8", marginTop: "4px" }}>Pick what to export and in which format.</div>
          </div>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", color: "#94a3b8", fontSize: "20px", cursor: "pointer", lineHeight: 1 }}
          >
            ✕
          </button>
        </div>

        {errorMessage && (
          <div
            style={{
              padding: "10px 12px",
              marginBottom: "12px",
              backgroundColor: "#450a0a",
              border: "1px solid #991b1b",
              borderRadius: "4px",
              color: "#fca5a5",
              fontSize: "12px",
            }}
          >
            {errorMessage}
          </div>
        )}
        {successMessage && (
          <div
            style={{
              padding: "10px 12px",
              marginBottom: "12px",
              backgroundColor: "rgba(34, 197, 94, 0.1)",
              border: "1px solid #22c55e",
              borderRadius: "4px",
              color: "#4ade80",
              fontSize: "12px",
              fontWeight: 700,
            }}
          >
            ✓ {successMessage}
          </div>
        )}

        <div style={{ flex: 1, overflowY: "auto" }}>
          <div style={{ display: "flex", gap: "8px", marginBottom: "16px" }}>
            <button style={kindToggleStyle(exportKind === "DEFINITIONS")} onClick={() => setExportKind("DEFINITIONS")}>
              Suite/Case Definitions
            </button>
            <button style={kindToggleStyle(exportKind === "EXECUTION_RESULTS")} onClick={() => setExportKind("EXECUTION_RESULTS")}>
              Execution Results
            </button>
          </div>

          <label style={labelStyle}>PROJECT</label>
          <select value={targetProjectId} onChange={(e) => setTargetProjectId(e.target.value)} style={{ ...selectStyle, marginBottom: "14px" }}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          {exportKind === "DEFINITIONS" ? (
            <>
              <label style={labelStyle}>SCOPE</label>
              <select
                value={scopeType}
                onChange={(e) => setScopeType(e.target.value as DefinitionsScopeType)}
                style={{ ...selectStyle, marginBottom: "10px" }}
              >
                <option value="PROJECT">Whole project</option>
                <option value="SUITE">A single suite (and its sub-suites)</option>
                <option value="PLAN">A test plan's linked cases (pinned versions)</option>
              </select>

              {scopeType === "SUITE" && (
                <select value={selectedSuiteId} onChange={(e) => setSelectedSuiteId(e.target.value)} style={{ ...selectStyle, marginBottom: "14px" }}>
                  <option value="">Select a suite...</option>
                  {flatSuites.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              )}

              {scopeType === "PLAN" && (
                <select value={selectedPlanId} onChange={(e) => setSelectedPlanId(e.target.value)} style={{ ...selectStyle, marginBottom: "14px" }}>
                  <option value="">Select a plan...</option>
                  {plans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              )}

              <label style={labelStyle}>CASE STATUS</label>
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)} style={{ ...selectStyle, marginBottom: "14px" }}>
                <option value="ALL">All statuses</option>
                <option value="APPROVED_ONLY">Approved only</option>
              </select>
            </>
          ) : (
            <>
              <label style={labelStyle}>PLAN</label>
              <select
                value={selectedPlanId}
                onChange={(e) => {
                  setSelectedPlanId(e.target.value);
                  setSelectedBuildId("");
                }}
                style={{ ...selectStyle, marginBottom: "10px" }}
              >
                <option value="">Select a plan...</option>
                {plans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>

              <label style={labelStyle}>BUILD</label>
              <select
                value={selectedBuildId}
                onChange={(e) => setSelectedBuildId(e.target.value)}
                disabled={!selectedPlanId}
                style={{ ...selectStyle, marginBottom: "14px" }}
              >
                <option value="">Select a build...</option>
                {builds.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </>
          )}

          <label style={labelStyle}>FORMAT</label>
          <select value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)} style={selectStyle}>
            <option value="NATIVE_JSON">Native JSON (full fidelity)</option>
            <option value="STANDARD_CSV">Standard CSV</option>
          </select>
          {format === "STANDARD_CSV" && exportKind === "DEFINITIONS" && (
            <div style={helperTextStyle}>
              CSV is directly re-importable, but is lossier than JSON: any priority other than High/Medium/Low becomes Medium on
              reimport, a custom field whose name collides with a built-in column (e.g. "Title") won't round-trip correctly, and
              multi-select values don't round-trip at all. Use JSON for exact fidelity.
            </div>
          )}
          {format === "STANDARD_CSV" && exportKind === "EXECUTION_RESULTS" && (
            <div style={helperTextStyle}>Environment tags aren't included in CSV -- use JSON if you need that data.</div>
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "16px", paddingTop: "16px", borderTop: "1px solid #1e293b" }}>
          <button onClick={onClose} style={secondaryButtonStyle}>
            Close
          </button>
          <button onClick={handleExport} disabled={!canExport} style={primaryButtonStyle(!canExport)}>
            {isLoading ? "Exporting..." : "Export ⬇"}
          </button>
        </div>
      </div>
    </div>
  );
}
