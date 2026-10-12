import { useCallback, useEffect, useRef, useState } from "react";
import type { SpecTreeData } from "../types";
import { authHeaders, jsonHeaders } from "../utils/session";

import { errorMessage } from "../api/errors";
import { api } from "../api/routes";
export interface SpecTreeOptions {
  selectedProjectId: string;
  selectedPlanId: string;
  showToast: (msg: string) => void;
}

/**
 * Spec mode's data: the project's suite/case tree (annotated with the selected plan's
 * membership), the tree's expand state and "Show deprecated", and adding/removing cases
 * and suites to/from the plan (with the confirmation for cases that have results).
 */
export function useSpecTree({ selectedProjectId, selectedPlanId, showToast }: SpecTreeOptions) {
  // Spec mode: deprecated cases are hidden from the case list (and tree counts) unless this is
  // on -- passed to GET .../spec-tree as include_deprecated. Session-only.
  const [showDeprecated, setShowDeprecated] = useState(false);

  // Suite tree expand/collapse (suite id -> expanded; a missing id means expanded). Owned here
  // so the filter panel's "Expand all"/"Collapse all" can drive it. Session-only.
  const [suiteExpandedMap, setSuiteExpandedMap] = useState<Record<string, boolean>>({});

  const [specData, setSpecData] = useState<SpecTreeData | null>(null);

  const [pendingToggleId, setPendingToggleId] = useState<string | null>(null);

  // Removing a case (or a suite's cases) that already has results asks first: the server
  // explains how many results it has; confirming retires it from the plan, keeping them.
  const [removeFromPlanPrompt, setRemoveFromPlanPrompt] = useState<{ kind: "case" | "suite"; id: string; detail: string } | null>(null);

  // The remove-from-plan confirmation acts on the selected plan -- drop it if that changes.
  useEffect(() => setRemoveFromPlanPrompt(null), [selectedPlanId]);

  // Guard against out-of-order fetch responses: switching project or plan (and the initial
  // load picking them) can fire several requests in quick succession. Without this, a
  // slower, now-stale response can resolve after a newer one and silently overwrite fresh data.
  const specTreeRequestSeq = useRef(0);

  // Specification-mode data: the whole project's suite/case spec, annotated with the
  // selected plan's inclusion state. Also drives Pane 1's suite tree in BOTH modes (see
  // suiteNodes in App), fixing the tree's pre-existing flat/fake-count display.
  const refreshSpecTree = useCallback(async () => {
    // test_plan_id is genuinely optional on this route (apps/server/src/routes/testPlanCases.ts) --
    // omitted, every case just comes back in_plan: false rather than 404ing. That's what makes
    // it safe to still fetch (and show real suites/cases, correctly annotated as not-in-plan)
    // when the project currently has no test plan at all, instead of leaving whatever was
    // fetched for a since-deleted plan stale on screen.
    if (!selectedProjectId) {
      // No project selected (none exist, or it was just deleted) -- drop the old tree.
      specTreeRequestSeq.current++;
      setSpecData(null);
      return;
    }
    const seq = ++specTreeRequestSeq.current;
    try {
      const url = api.specTree(selectedProjectId, { test_plan_id: selectedPlanId || undefined, include_deprecated: showDeprecated });
      const res = await fetch(url, { headers: authHeaders() });
      const data = res.ok ? await res.json() : null;
      if (specTreeRequestSeq.current === seq) setSpecData(data);
    } catch {
      if (specTreeRequestSeq.current === seq) setSpecData(null);
    }
  }, [selectedProjectId, selectedPlanId, showDeprecated]);

  // Per-case/suite plan-inclusion toggles (Specification mode). Both call the new
  // apps/server/src/routes/testPlanCases.ts endpoints, then refresh the spec tree so
  // in_plan/tri-state counts reflect the change.
  const handleToggleCaseInclusion = useCallback(
    async (testCaseId: string, include: boolean, force = false) => {
      if (!selectedPlanId) {
        showToast("No test plan selected");
        return;
      }
      setPendingToggleId(testCaseId);
      try {
        const res = await fetch(
          include ? api.planCases(selectedPlanId) : api.planCase(selectedPlanId, testCaseId, force),
          {
            method: include ? "POST" : "DELETE",
            // Content-Type: application/json on a bodyless DELETE trips Fastify's JSON body
            // parser (it 400s on an empty body when that header is present) -- only set it
            // when there's actually a JSON body to send.
            headers: include
              ? jsonHeaders()
              : { ...authHeaders() },
            body: include ? JSON.stringify({ test_case_id: testCaseId }) : undefined,
          },
        );
        if (res.ok) {
          showToast(include ? "Added to plan" : force ? "Removed from plan -- its results stay in earlier runs" : "Removed from plan");
          await refreshSpecTree();
        } else if (res.status === 409 && !include) {
          const body = await res.json().catch(() => ({}) as any);
          setRemoveFromPlanPrompt({ kind: "case", id: testCaseId, detail: body.detail || "This case has results. Remove it anyway?" });
        } else {
          const body = await res.json().catch(() => ({}) as any);
          showToast(`🔒 ${errorMessage(body) || "Could not update plan membership"}`);
        }
      } catch {
        showToast("Network error updating plan membership");
      } finally {
        setPendingToggleId(null);
      }
    },
    [selectedPlanId, showToast, refreshSpecTree],
  );

  const handleToggleSuiteInclusion = useCallback(
    async (suiteId: string, action: "ADD" | "REMOVE", force = false) => {
      if (!selectedPlanId) {
        showToast("No test plan selected");
        return;
      }
      setPendingToggleId(suiteId);
      try {
        // POST adds every case in the suite's subtree; DELETE removes them (no body).
        const res = await fetch(api.planSuiteCases(selectedPlanId, suiteId, action === "REMOVE" && force), {
          method: action === "ADD" ? "POST" : "DELETE",
          headers: authHeaders(),
        });
        if (res.ok) {
          const body = await res.json();
          const parts: string[] = [];
          if (body.added) parts.push(`${body.added} added`);
          const removedTotal = (body.removed || 0) + (body.retired || 0);
          if (removedTotal) {
            parts.push(
              `${removedTotal} removed from the plan` +
                (body.retired ? ` (${body.retired === removedTotal ? (removedTotal === 1 ? "it keeps its" : "all keep their") : `${body.retired} keep their`} results in earlier runs)` : ""),
            );
          }
          if (body.skipped?.length) parts.push(`${body.skipped.length} skipped`);
          showToast(parts.length > 0 ? parts.join(", ") : "No changes");
          await refreshSpecTree();
        } else if (res.status === 409 && action === "REMOVE") {
          const body = await res.json().catch(() => ({}) as any);
          setRemoveFromPlanPrompt({ kind: "suite", id: suiteId, detail: body.detail || "Some cases have results. Remove them anyway?" });
        } else {
          const body = await res.json().catch(() => ({}) as any);
          showToast(`🔒 ${errorMessage(body) || "Could not update plan membership"}`);
        }
      } catch {
        showToast("Network error updating plan membership");
      } finally {
        setPendingToggleId(null);
      }
    },
    [selectedPlanId, showToast, refreshSpecTree],
  );

  return {
    showDeprecated,
    setShowDeprecated,
    suiteExpandedMap,
    setSuiteExpandedMap,
    specData,
    setSpecData,
    pendingToggleId,
    setPendingToggleId,
    removeFromPlanPrompt,
    setRemoveFromPlanPrompt,
    specTreeRequestSeq,
    refreshSpecTree,
    handleToggleCaseInclusion,
    handleToggleSuiteInclusion,
  };
}

export type SpecTree = ReturnType<typeof useSpecTree>;
