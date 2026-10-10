import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { UserProfile } from "../components/AuthModal";
import type { SuiteTreeNode } from "../components/VirtualizedSuiteTree";
import { useFocusFSM } from "./useFocusFSM";
import type { VerdictType } from "./useHotkeyEngine";
import type { ExecutionWorkspace } from "./useExecutionWorkspace";
import type { Scope } from "./useScope";
import type { CustomFieldValueEntry, TestCase } from "../types";
import {
  NO_RUN_MESSAGE,
  OVERWRITE_DENIED_MESSAGE,
  REMOVED_CASE_MESSAGE,
  RUN_CLOSED_MESSAGE,
  RUN_DENIED_MESSAGE,
} from "../app/messages";
import { buildExecutionCaseOrder } from "../utils/executionCaseOrder";
import { flattenSuiteOptions } from "../utils/suiteTree";
import { authHeaders, jsonHeaders } from "../utils/session";

export interface ExecutionOptions {
  executionWorkspace: ExecutionWorkspace;
  workspaceMode: "EXECUTION" | "SPECIFICATION";
  userPermissions: string[];
  scope: Scope;
  /** The active search/filter's matches, or null when none is active. */
  filterResult: { caseIds: Set<string>; suiteIds: Set<string> } | null;
  /** The suite tree as shown (its order is the queue's folder order). */
  suiteNodes: SuiteTreeNode[];
  /** Execute mode's suite selection, which narrows the queue to that suite. */
  execSuiteFilterId: string | null;
  setExecSuiteFilterId: Dispatch<SetStateAction<string | null>>;
  showToast: (msg: string) => void;
  setCurrentUser: (user: UserProfile | null) => void;
  setUserPermissions: (permissions: string[]) => void;
  /** Bumped when an admin changes a custom field definition. */
  customFieldDefsVersion: number;
}

/**
 * Execute mode: which case is active, its notes and custom fields, recording a result
 * (optimistically, reverted if the server refuses), when recording is blocked, and the
 * queue's order for moving on to the next case.
 */
export function useExecution({
  executionWorkspace,
  workspaceMode,
  userPermissions,
  scope,
  filterResult,
  suiteNodes,
  execSuiteFilterId,
  setExecSuiteFilterId,
  showToast,
  setCurrentUser,
  setUserPermissions,
  customFieldDefsVersion,
}: ExecutionOptions) {
  const { workspace, setWorkspace } = executionWorkspace;
  const { selectedProjectId, selectedRunId, selectedRun, setRunsList } = scope;
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const [failureNotes, setFailureNotes] = useState<string>("");
  const [syncStatus, setSyncStatus] = useState<string>("Connected");
  // Read-only custom field values for the case currently being executed (Execution mode).
  const [execCaseCustomFieldValues, setExecCaseCustomFieldValues] = useState<
    CustomFieldValueEntry[] | null
  >(null);
  // Shown as a yellow banner when the server refuses to record a result (403): easy to miss as
  // a status-bar message, especially when recording with the keyboard.
  // The yellow "Not permitted" banner's message, or null when it's hidden.
  const [executionDenied, setExecutionDenied] = useState<string | null>(null);
  const notesInputRef = useRef<HTMLTextAreaElement>(null);

  // Which verdict the notes textarea is currently "for" -- set whenever Fail/Block is
  // triggered (hotkey or button) so a later Ctrl+Enter/blur submit uses that verdict
  // instead of always assuming FAILED.
  const pendingVerdictRef = useRef<VerdictType>("FAILED");
  // Whether the textarea has unsubmitted user edits. A plain ref (not state) so the
  // Ctrl+Enter path can mark it false synchronously before its own .blur() call fires the
  // textarea's onBlur handler, avoiding a duplicate submission from that same keypress.
  const notesDirtyRef = useRef(false);

  const activeCase = workspace?.cases[selectedIndex] || null;
  const isCompleted =
    activeCase?.latest_verdict && activeCase.latest_verdict !== "UNTESTED";

  // Keyboard Focus FSM
  const fsm = useFocusFSM({
    initialZone: "EXECUTION_CONTAINER",
    permissions: userPermissions,
    isExecutionCompleted: Boolean(isCompleted),
  });

  // A refusal in one project says nothing about the next one.
  useEffect(() => {
    setExecutionDenied(null);
  }, [selectedProjectId]);

  // Custom field values for whichever case is active in Execution mode -- shown read-only
  // under the steps. Same clear-before-fetch discipline as the Spec-mode case's fetch in App (the
  // editors are uncontrolled, so nothing stale may be mounted while the fetch is in flight).
  const activeExecCaseId = activeCase?.case_id ?? null;
  useEffect(() => {
    if (workspaceMode !== "EXECUTION" || !activeExecCaseId) {
      setExecCaseCustomFieldValues(null);
      return;
    }
    setExecCaseCustomFieldValues(null);
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/v1/test-cases/${activeExecCaseId}/custom-field-values`, {
          headers: authHeaders(),
        });
        if (!cancelled) setExecCaseCustomFieldValues(res.ok ? (await res.json()).values : null);
      } catch {
        if (!cancelled) setExecCaseCustomFieldValues(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceMode, activeExecCaseId, customFieldDefsVersion]);

  // Execute verdict submission (Optimistic UI + Background API)
  // A CLOSED run is read-only: no verdicts, no notes (the server also refuses them with
  // 422 BUILD_CLOSED). A run closes manually via the Close Run button, or automatically once
  // every case in the plan has a result.
  const isRunClosed = workspaceMode === "EXECUTION" && selectedRun?.status === "CLOSED";
  const isRunMissing = workspaceMode === "EXECUTION" && !selectedRunId;
  // Why results can't be recorded right now (null = they can). Drives the verdict buttons,
  // Notes, the hotkey block, and submitVerdict's own guard.
  const verdictBlockReason: string | null = isRunMissing
    ? NO_RUN_MESSAGE
    : isRunClosed
      ? RUN_CLOSED_MESSAGE
      : workspaceMode === "EXECUTION" && activeCase?.removed_from_plan
        ? REMOVED_CASE_MESSAGE
        : null;

  const submitVerdict = useCallback(
    async (
      verdict: VerdictType,
      notes?: string,
      targetCaseOverride?: TestCase,
    ) => {
      const targetCase = targetCaseOverride || activeCase;
      if (!targetCase || !workspace) return;
      if (verdictBlockReason) {
        showToast(verdictBlockReason);
        return;
      }

      // Whatever's in the Notes field gets saved regardless of verdict -- it's a general
      // "execution details or notes" field (see its placeholder), not failure-only, so a
      // note typed before hitting Pass/Skip shouldn't be silently discarded just because the
      // verdict isn't FAILED/BLOCKED.
      const resolvedNotes = notes || (failureNotes.trim() ? failureNotes : null);

      // 1. OPTIMISTIC UI UPDATE (<10ms) -- also updates latest_notes, not just
      // latest_verdict, so returning to this case (without a full refetch) shows the note
      // that was just submitted instead of whatever was cached from before.
      setWorkspace((prev) => {
        if (!prev) return prev;
        const updatedCases = prev.cases.map((c) =>
          c.plan_case_id === targetCase.plan_case_id
            ? { ...c, latest_verdict: verdict, latest_notes: resolvedNotes }
            : c,
        );
        return { ...prev, cases: updatedCases };
      });

      // If the server doesn't save it, put the case back as it was -- otherwise the grid would
      // keep showing a result that was never recorded.
      const revertOptimisticUpdate = () =>
        setWorkspace((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            cases: prev.cases.map((c) =>
              c.plan_case_id === targetCase.plan_case_id
                ? { ...c, latest_verdict: targetCase.latest_verdict, latest_notes: targetCase.latest_notes }
                : c,
            ),
          };
        });

      setSyncStatus(`Syncing verdict for ${targetCase.external_id}...`);

      // 2. DISPATCH BACKGROUND API CALL
      try {
        const response = await fetch("/api/v1/executions", {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({
            // The run selected in the dropdown -- workspace.build is always the plan's newest
            // run, so using it recorded results against the wrong run whenever an older
            // run was selected.
            build_id: selectedRunId,
            test_plan_case_id: targetCase.plan_case_id,
            verdict,
            status: "COMPLETED",
            notes: resolvedNotes,
            // No duration: manual execution isn't timed (this used to send a random
            // 200-1000ms, which made Reports' "Slowest" table meaningless).
          }),
        });

        if (response.ok) {
          setExecutionDenied(null);
          setSyncStatus(
            `Connected (Recorded ${targetCase.external_id} -> ${verdict})`,
          );
          const data = await response.json().catch(() => ({}));
          const recordedRunId = selectedRunId;
          if (data.build_status === "CLOSED") {
            setRunsList((prev) =>
              prev.map((r) => (r.id === recordedRunId ? { ...r, status: "CLOSED" } : r)),
            );
          }
        } else if (response.status === 401) {
          // Session expired or token invalid -- the server now requires a real, current
          // sign-in for this route (EXECUTE_RUN permission). Drop back to the login screen
          // rather than silently failing every subsequent keystroke.
          setCurrentUser(null);
          setUserPermissions([]);
          setSyncStatus("Session expired -- please log in again");
        } else if (response.status === 403) {
          revertOptimisticUpdate();
          const denial = await response.json().catch(() => ({}));
          if (denial.code === "RESULT_OVERWRITE_NOT_PERMITTED") {
            setSyncStatus("Not permitted: your role can't change an existing result");
            setExecutionDenied(OVERWRITE_DENIED_MESSAGE);
          } else {
            setSyncStatus("Not permitted: your role can't record executions");
            setExecutionDenied(RUN_DENIED_MESSAGE);
          }
        } else {
          revertOptimisticUpdate();
          setSyncStatus("API Error recording verdict");
        }
      } catch (err) {
        revertOptimisticUpdate();
        setSyncStatus("Network Error");
      }
    },
    [activeCase, workspace, failureNotes, verdictBlockReason, selectedRunId, showToast],
  );

  // Execution mode: indices into workspace.cases that pass the active search/filter (all of
  // them when none is active). selectedIndex always stays an index into workspace.cases --
  // the queue grid and hotkeys work in "visible position" space and map back through this,
  // so a filtered list can never select the wrong case. The active case may itself be
  // hidden by a filter (selection is left alone while typing); then no row is highlighted.
  const visibleCaseIndices: number[] = (workspace?.cases || []).reduce<number[]>((acc, c, i) => {
    if (!filterResult || filterResult.caseIds.has((c as any).case_id ?? "")) acc.push(i);
    return acc;
  }, []);
  const visibleCaseIndexSet = new Set(visibleCaseIndices);
  // What the queue grid actually lists: the search/filter result, further narrowed to the
  // selected suite's own cases when one is selected in Execute mode. j/k and the grid work in
  // this list's positions; advancing after a verdict can step past its end into the next
  // suite (see advanceToCase / crossSuiteNextCaseIndex below).
  const queueCaseIndices: number[] = execSuiteFilterId
    ? visibleCaseIndices.filter((i) => workspace?.cases[i]?.test_suite_id === execSuiteFilterId)
    : visibleCaseIndices;
  const selectedVisiblePos = queueCaseIndices.indexOf(selectedIndex);

  // Moving to a different case should show THAT case's own saved notes (if it already has
  // any from a prior execution), not the previous case's leftover draft text -- any
  // unsubmitted draft was already saved by the textarea's onBlur handler (ExecutionPane) (which fires
  // as focus leaves it, before selectedIndex actually changes). Loading an existing note
  // here is not a user edit, so notesDirtyRef stays false (nothing to resubmit on blur
  // unless the user actually changes it).
  useEffect(() => {
    setFailureNotes(activeCase?.latest_notes || "");
    notesDirtyRef.current = false;
    // A note-only Ctrl+Enter (no verdict hotkey pressed since arriving on this case) should
    // resubmit whatever verdict the case already has, not silently reassign it -- e.g.
    // navigating to an already-SKIPPED case and just adding a note must not flip it to
    // FAILED. Only default to FAILED for a genuinely UNTESTED case, matching the existing
    // convention that an explain-why note with no verdict chosen yet implies a failure.
    const existingVerdict = activeCase?.latest_verdict;
    pendingVerdictRef.current =
      existingVerdict && existingVerdict !== "UNTESTED"
        ? (existingVerdict as VerdictType)
        : "FAILED";
  }, [selectedIndex, activeCase?.latest_notes, activeCase?.latest_verdict]);

  // Calculate Pass/Fail ratio metrics for Pane 1
  const passedCount = workspace.cases.filter(
    (c) => c.latest_verdict === "PASSED",
  ).length;
  const failedCount = workspace.cases.filter(
    (c) => c.latest_verdict === "FAILED",
  ).length;

  // Execution mode's Ctrl+Enter "jump to next folder" advance (onSubmitNotes, in App's hotkey wiring)
  // needs cases ordered by suite-tree position -- see buildExecutionCaseOrder's own comment
  // for why workspace.cases' own order can't be used directly.
  const executionCaseOrderByCaseIndex: number[] =
    workspaceMode === "EXECUTION" && workspace
      ? buildExecutionCaseOrder(workspace.cases, flattenSuiteOptions(suiteNodes).map((s) => s.id)).filter(
          // Ctrl+Enter's next-folder jump only ever lands on cases the filter shows.
          (i) => !filterResult || visibleCaseIndexSet.has(i),
        )
      : [];

  // Moves the active case; when the queue is narrowed to one suite and the target lives in a
  // different suite, the suite selection follows it, so the newly active case is always in
  // the visible list (finishing a suite's last case flows on into the next suite).
  const advanceToCase = (target: number) => {
    setSelectedIndex(target);
    const targetSuiteId = workspace?.cases[target]?.test_suite_id;
    if (execSuiteFilterId && targetSuiteId && targetSuiteId !== execSuiteFilterId) {
      setExecSuiteFilterId(targetSuiteId);
    }
  };
  // The next case after the active one in suite-tree order that's in a DIFFERENT suite --
  // only meaningful while the queue is narrowed to one suite (otherwise undefined).
  const crossSuiteNextCaseIndex: number | undefined = (() => {
    if (!execSuiteFilterId) return undefined;
    const pos = executionCaseOrderByCaseIndex.indexOf(selectedIndex);
    return executionCaseOrderByCaseIndex
      .slice(pos + 1)
      .find((i) => workspace?.cases[i]?.test_suite_id !== execSuiteFilterId);
  })();
  // Next case for the Pass/Skip buttons: the next one in the visible queue, or -- at the end
  // of a suite-narrowed queue -- the first case of the next suite.
  const nextVisibleCaseIndex: number | undefined =
    queueCaseIndices.find((i) => i > selectedIndex) ?? crossSuiteNextCaseIndex;

  return {
    selectedIndex,
    setSelectedIndex,
    failureNotes,
    setFailureNotes,
    syncStatus,
    executionDenied,
    setExecutionDenied,
    execCaseCustomFieldValues,
    activeExecCaseId,
    notesInputRef,
    pendingVerdictRef,
    notesDirtyRef,
    activeCase,
    fsm,
    isRunMissing,
    verdictBlockReason,
    submitVerdict,
    visibleCaseIndices,
    queueCaseIndices,
    selectedVisiblePos,
    executionCaseOrderByCaseIndex,
    advanceToCase,
    crossSuiteNextCaseIndex,
    nextVisibleCaseIndex,
    passedCount,
    failedCount,
  };
}

export type Execution = ReturnType<typeof useExecution>;
