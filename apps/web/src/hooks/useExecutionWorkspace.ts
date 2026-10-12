import { useCallback, useRef, useState } from "react";
import type { EntityItem } from "../components/EntityManagementModal";
import type { Scope } from "./useScope";
import type { ExecWorkspaceStatus, WorkspaceData } from "../types";
import { authHeaders } from "../utils/session";
import { api } from "../api/routes";

// Execute mode before (or without) a loaded plan: nothing to show. (This used to be two
// made-up cases, TFY-101/102, which appeared whenever no plan was selected or a load failed.)
export const EMPTY_WORKSPACE: WorkspaceData = {
  project: { id: "", name: "", prefix: "" },
  suites: [],
  plan: { id: "", name: "", status: "" },
  run: { id: "", name: "", status: "" },
  cases: [],
};

/**
 * Execute mode's data: the selected plan's cases, with results from the selected run, and
 * whether they're loaded. Loading also keeps the Run dropdown in step (the plan's runs come
 * with its cases).
 */
export function useExecutionWorkspace(scope: Scope) {
  const { selectedProjectId, selectedPlanId, selectedRunId, projectsList, runsListRequestSeq, setRunsList, setSelectedRunId } = scope;
  // Starts empty, never null: the app opens in Spec mode, which doesn't load this, and
  // execWorkspaceStatus says whether it's loaded. The real data loads when Execute mode needs it.
  const [workspace, setWorkspace] = useState<WorkspaceData>(EMPTY_WORKSPACE);
  const [execWorkspaceStatus, setExecWorkspaceStatus] = useState<ExecWorkspaceStatus>("NO_PLAN");
  // Read by refreshExecutionWorkspace (a callback that shouldn't re-create on every load).
  const workspaceRef = useRef<WorkspaceData | null>(workspace);
  workspaceRef.current = workspace;

  // Execution-mode workspace: the selected plan's cases, with results from the selected run.
  const refreshExecutionWorkspace = useCallback(async () => {
    // Bump the sequence guard BEFORE the early-return, not after -- App's refresh effect fires
    // on selectedProjectId changing even when selectedPlanId hasn't caught up yet (loadPlans
    // clears it asynchronously), so a project switch can call this once with the *previous*
    // project's still-current selectedPlanId (a real, valid plan id, so its fetch succeeds)
    // and then again after selectedPlanId clears to "". If the early-return below didn't bump
    // the sequence, the first call's in-flight fetch could resolve after the second call has
    // already (correctly) cleared runsList, silently repopulating it with the old project's
    // run -- exactly the "switching to a project with no plans leaves a stale Run selected"
    // bug this guards against.
    const seq = ++runsListRequestSeq.current;
    if (!selectedPlanId) {
      if (runsListRequestSeq.current === seq) {
        setWorkspace(EMPTY_WORKSPACE);
        setExecWorkspaceStatus("NO_PLAN");
        setRunsList([]);
        setSelectedRunId("");
      }
      return;
    }
    // Only a different plan shows "Loading" -- a refresh of the same plan keeps its cases up.
    setExecWorkspaceStatus((prev) => (prev === "READY" && workspaceRef.current?.plan.id === selectedPlanId ? prev : "LOADING"));
    try {
      const res = await fetch(api.planCases(selectedPlanId, { test_run_id: selectedRunId || undefined }), { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        if (runsListRequestSeq.current !== seq) return; // a newer request already resolved
        const projectEntity = projectsList.find((p) => p.id === selectedProjectId);
        const runs = data.runs || [];

        setWorkspace({
          project: projectEntity
            ? {
                id: projectEntity.id,
                name: projectEntity.name,
                prefix: projectEntity.prefix || "TFY",
              }
            : EMPTY_WORKSPACE.project,
          suites: [],
          plan: { id: data.plan.id, name: data.plan.name, status: data.plan.status },
          run: runs[0]
            ? { id: runs[0].id, name: runs[0].name, status: runs[0].status }
            : EMPTY_WORKSPACE.run,
          cases: data.cases.map((c: any) => ({
            test_plan_case_id: c.test_plan_case_id,
            test_case_id: c.test_case_id,
            test_suite_id: c.test_suite_id,
            external_id: c.external_id,
            title: c.title,
            priority: c.priority,
            execution_type: c.execution_type,
            version_number: c.version_number,
            summary: c.summary,
            preconditions: c.preconditions,
            steps: c.steps,
            latest_verdict: c.latest_verdict || "UNTESTED",
            latest_test_result_id: c.latest_test_result_id || null,
            latest_notes: c.latest_notes || null,
            removed_from_plan: Boolean(c.removed_from_plan),
          })),
        });
        setExecWorkspaceStatus("READY");

        // Always update runsList/selectedRunId, even when runs is empty -- a plan that
        // genuinely has zero runs must clear the dropdown, not leave the *previous* plan's
        // runs showing (the old `if (runs.length > 0)` guard here skipped both setters
        // entirely on an empty result, which is the same staleness bug already fixed for
        // loadPlans/the selectedPlanId-empty case, just triggered here by switching to a
        // *real* plan that has no runs rather than having no plan at all).
        const runItems: EntityItem[] = runs.map((b: any) => ({
          id: b.id,
          name: (b.name || "").replace(/^Build\s+/i, "Run "),
          status: b.status,
        }));
        setRunsList(runItems);
        setSelectedRunId((prev) =>
          runItems.length === 0 ? "" : runItems.some((r) => r.id === prev) ? prev : runItems[0].id,
        );
        return;
      }
    } catch {
      // API offline fallback
    }
    if (runsListRequestSeq.current === seq) {
      // Show the failure (with Retry) rather than cases that aren't this plan's.
      setWorkspace(EMPTY_WORKSPACE);
      setExecWorkspaceStatus("ERROR");
      // Same staleness concern as above -- a failed fetch shouldn't leave a previous plan's
      // runs showing under the (now unconfirmed) currently-selected plan.
      setRunsList([]);
      setSelectedRunId("");
    }
  }, [selectedPlanId, selectedProjectId, selectedRunId, projectsList]);

  return { workspace, setWorkspace, execWorkspaceStatus, refreshExecutionWorkspace };
}

export type ExecutionWorkspace = ReturnType<typeof useExecutionWorkspace>;
