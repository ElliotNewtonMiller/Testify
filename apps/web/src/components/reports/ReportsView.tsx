import React from "react";
import { CaseFilterPanel, EMPTY_CASE_FILTER, isFieldAvailable, toApiFilters, type CaseFilterField, type CaseFilterState } from "../CaseFilterPanel";
import { OverviewTab } from "./OverviewTab";
import { RunTab, type CompareChoice } from "./RunTab";
import { TrendsTab } from "./TrendsTab";
import { HealthTab } from "./HealthTab";
import { CaseHistoryDrawer } from "./CaseHistoryDrawer";
import { InfoTip, type EmailContext } from "./shared";
import { SchedulesTab } from "./SchedulesTab";
import { EmailReportDialog } from "./EmailReportDialog";

export const REPORT_TABS = [
  { id: "overview", label: "Overview", hint: "Status of every active plan: its latest run, new failures, spec health and testing activity." },
  { id: "run", label: "Run", hint: "What broke in the selected run, and what changed since the run before it." },
  { id: "trends", label: "Trends & Breakdown", hint: "How the plan moves across runs, and how groups of cases (suite, priority, custom fields...) compare." },
  { id: "health", label: "Test Health", hint: "Flaky, slow, always-failing and stale cases across the plan's recent runs." },
  { id: "schedules", label: "Scheduled Emails", hint: "Send reports to stakeholders automatically, daily or weekly." },
] as const;
export type ReportsTabId = (typeof REPORT_TABS)[number]["id"];

/** Everything a shareable Reports link carries. Stored in the URL hash, e.g.
 * #/reports/run?project=..&plan=..&run=..&case=..&compare=.. */
export interface ReportsLink {
  tab: ReportsTabId;
  project: string | null;
  plan: string | null;
  run: string | null;
  caseId: string | null;
  compare: string | null;
}

export function parseReportsHash(hash: string): ReportsLink | null {
  const m = /^#\/reports(?:\/([a-z]+))?(?:\?(.*))?$/.exec(hash);
  if (!m) return null;
  const tab = (REPORT_TABS.find((t) => t.id === m[1])?.id ?? "overview") as ReportsTabId;
  const q = new URLSearchParams(m[2] ?? "");
  return { tab, project: q.get("project"), plan: q.get("plan"), run: q.get("run"), caseId: q.get("case"), compare: q.get("compare") };
}

function buildReportsHash(link: ReportsLink): string {
  const q = new URLSearchParams();
  if (link.project) q.set("project", link.project);
  if (link.plan) q.set("plan", link.plan);
  if (link.run) q.set("run", link.run);
  if (link.caseId) q.set("case", link.caseId);
  if (link.compare) q.set("compare", link.compare);
  const query = q.toString();
  return `#/reports/${link.tab}${query ? `?${query}` : ""}`;
}

export interface ReportsViewProps {
  projectId: string;
  projectName: string;
  planId: string;
  runId: string;
  runs: Array<{ id: string; name: string }>;
  /** The project's plans, for picking one in a scheduled email. */
  plans: Array<{ id: string; name: string; status?: string }>;
  /** Holds REPORT_EMAIL: can email reports and manage scheduled emails. */
  canEmail: boolean;
  /** Selects a plan in the header (its latest run becomes the selected run). */
  onSelectPlan: (planId: string) => void;
  onOpenInSpec: (caseId: string) => void;
  initialLink: ReportsLink | null;
}

/**
 * The Reports view -- replaces the three panes while open, keeping the header's Project /
 * Plan / Run pickers as its scope. Every number comes from the report API, the same engine
 * scripts and agents use. The current tab, scope, open case and comparison live in the URL
 * hash, so a link reopens exactly this report.
 */
export function ReportsView({ projectId, projectName, planId, runId, runs, plans, canEmail, onSelectPlan, onOpenInSpec, initialLink }: ReportsViewProps) {
  const [tabState, setTab] = React.useState<ReportsTabId>(initialLink?.tab ?? "overview");
  // Without REPORT_EMAIL the schedules tab doesn't exist (e.g. a link from someone who has it).
  const tab: ReportsTabId = tabState === "schedules" && !canEmail ? "overview" : tabState;
  const [emailContext, setEmailContext] = React.useState<EmailContext | null>(null);
  const [emailOpen, setEmailOpen] = React.useState(false);
  const [caseId, setCaseId] = React.useState<string | null>(initialLink?.caseId ?? null);
  const [compareTo, setCompareTo] = React.useState<CompareChoice>(initialLink?.compare ?? "previous");
  const [filterState, setFilterState] = React.useState<CaseFilterState>(EMPTY_CASE_FILTER);
  const [fields, setFields] = React.useState<CaseFilterField[]>([]);
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const [copied, setCopied] = React.useState(false);

  // A different run invalidates an explicit comparison choice.
  const firstRun = React.useRef(true);
  React.useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    setCompareTo("previous");
  }, [runId]);

  const loadFields = React.useCallback(() => {
    if (!projectId) return;
    const token = localStorage.getItem("auth_token");
    fetch(`/api/v1/projects/${projectId}/case-search/fields`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((res) => (res.ok ? res.json() : { fields: [] }))
      .then((d) => setFields(d.fields || []))
      .catch(() => setFields([]));
  }, [projectId]);
  React.useEffect(() => {
    loadFields();
    setFilterState(EMPTY_CASE_FILTER);
  }, [loadFields]);

  // The filter as the report API expects it, debounced so typing doesn't refetch per key.
  const fieldsByKey = React.useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields]);
  const ctx = { mode: "EXECUTION" as const, hasPlan: Boolean(planId), hasRun: Boolean(runId) };
  const apiFilters = toApiFilters(filterState.filters, fieldsByKey, (f) => isFieldAvailable(f, ctx));
  const q = filterState.q.trim();
  const filterKey = q || apiFilters.length > 0 ? JSON.stringify({ ...(q ? { q } : {}), filters: apiFilters }) : "";
  const [debouncedFilterKey, setDebouncedFilterKey] = React.useState(filterKey);
  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedFilterKey(filterKey), 300);
    return () => clearTimeout(t);
  }, [filterKey]);
  const filter = React.useMemo(() => (debouncedFilterKey ? (JSON.parse(debouncedFilterKey) as Record<string, unknown>) : null), [debouncedFilterKey]);

  // Keep the URL hash in sync, so the address is always a link to this exact report.
  const link: ReportsLink = { tab, project: projectId || null, plan: planId || null, run: runId || null, caseId, compare: compareTo === "previous" ? null : compareTo };
  const hash = buildReportsHash(link);
  React.useEffect(() => {
    if (window.location.hash !== hash) window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${hash}`);
  }, [hash]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable (e.g. insecure context) -- the address bar still has the link
    }
  };

  if (!projectId) {
    return <div style={{ padding: "24px", color: "#64748b", fontSize: "13px" }}>Create or select a project to see reports.</div>;
  }

  const runName = runs.find((r) => r.id === runId)?.name ?? null;
  const usesFilter = tab !== "overview" && tab !== "schedules";
  const canEmailThis = canEmail && tab !== "schedules" && emailContext !== null;

  return (
    <div style={{ display: "flex", flex: 1, overflow: "hidden", backgroundColor: "#090d16" }}>
      <nav style={{ width: 250, flexShrink: 0, borderRight: "1px solid #1f2937", backgroundColor: "#0b0f19", display: "flex", flexDirection: "column", overflowY: "auto" }}>
        <div style={{ padding: "14px 14px 8px" }}>
          <div style={{ fontSize: "10px", fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            <InfoTip
              placement="right"
              text={
                <>
                  Scoped by the Project, Plan and Run pickers in the header. Scripts and AI agents get the same numbers from{" "}
                  <code>POST /api/v1/projects/:id/reports/:report</code> or the MCP endpoint at <code>/mcp</code>.
                </>
              }
            >
              Reports
            </InfoTip>
          </div>
          <div style={{ fontSize: "13px", fontWeight: 700, color: "#e2e8f0", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{projectName}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", padding: "0 8px", gap: "2px" }}>
          {REPORT_TABS.filter((t) => t.id !== "schedules" || canEmail).map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                textAlign: "left",
                padding: "8px 10px",
                borderRadius: "6px",
                border: "none",
                cursor: "pointer",
                backgroundColor: tab === t.id ? "rgba(14, 165, 233, 0.15)" : "transparent",
                borderLeft: tab === t.id ? "3px solid #0ea5e9" : "3px solid transparent",
              }}
            >
              <div style={{ fontSize: "12px", fontWeight: 700, color: tab === t.id ? "#f1f5f9" : "#cbd5e1" }}>
                <InfoTip text={t.hint} placement="right">
                  {t.label}
                </InfoTip>
              </div>
            </button>
          ))}
        </div>

        <div style={{ padding: "14px 8px 8px", borderTop: "1px solid #1f2937", marginTop: "12px", opacity: usesFilter ? 1 : 0.45 }}>
          <div style={{ fontSize: "10px", fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em", padding: "0 6px 6px" }}>
            <InfoTip placement="right" text="Limits every report except the Overview to the cases matching this search and these filters.">
              Limit to cases
            </InfoTip>
          </div>
          <CaseFilterPanel
            value={filterState}
            onChange={setFilterState}
            fields={fields}
            mode="EXECUTION"
            hasPlan={Boolean(planId)}
            hasRun={Boolean(runId)}
            searchInputRef={searchInputRef}
            matchCount={null}
            totalCount={0}
            onRequestFields={loadFields}
          />
        </div>

        <div style={{ marginTop: "auto", padding: "12px 14px", borderTop: "1px solid #1f2937", display: "flex", flexDirection: "column", gap: "6px" }}>
          {canEmail && tab !== "schedules" && (
            <button
              onClick={() => setEmailOpen(true)}
              disabled={!canEmailThis}
              title={canEmailThis ? "Email this report to stakeholders" : "Pick a plan or run to email this report"}
              style={{ padding: "5px 10px", backgroundColor: "#0284c7", border: "none", borderRadius: "4px", color: "#fff", fontSize: "11px", fontWeight: 600, cursor: canEmailThis ? "pointer" : "not-allowed", opacity: canEmailThis ? 1 : 0.5 }}
            >
              ✉ Email this report
            </button>
          )}
          <button
            onClick={copyLink}
            style={{ padding: "5px 10px", backgroundColor: "transparent", border: "1px solid #334155", borderRadius: "4px", color: "#cbd5e1", fontSize: "11px", fontWeight: 600, cursor: "pointer" }}
          >
            {copied ? "✓ Link copied" : "🔗 Copy link to this report"}
          </button>
        </div>
      </nav>

      <main style={{ flex: 1, overflowY: "auto", padding: "16px 20px 32px", minWidth: 0 }}>
        {tab === "overview" && (
          <OverviewTab
            projectId={projectId}
            onOpenCase={setCaseId}
            onEmailContext={setEmailContext}
            onOpenRun={(id) => {
              onSelectPlan(id);
              setTab("run");
            }}
          />
        )}
        {tab === "run" && (
          <RunTab projectId={projectId} runId={runId} runs={runs} compareTo={compareTo} onCompareToChange={setCompareTo} filter={filter} onOpenCase={setCaseId} onEmailContext={setEmailContext} />
        )}
        {tab === "trends" && <TrendsTab projectId={projectId} planId={planId} runId={runId} runName={runName} fields={fields} filter={filter} onEmailContext={setEmailContext} />}
        {tab === "health" && <HealthTab projectId={projectId} planId={planId} filter={filter} onOpenCase={setCaseId} onEmailContext={setEmailContext} />}
        {tab === "schedules" && canEmail && <SchedulesTab projectId={projectId} plans={plans} defaultPlanId={planId} />}
      </main>

      {emailOpen && emailContext && <EmailReportDialog projectId={projectId} what={emailContext.what} sections={emailContext.sections} onClose={() => setEmailOpen(false)} />}
      {caseId && <CaseHistoryDrawer projectId={projectId} caseId={caseId} onClose={() => setCaseId(null)} onOpenInSpec={onOpenInSpec} />}
    </div>
  );
}
