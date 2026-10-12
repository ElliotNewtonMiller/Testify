import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { useStepsScrollPreserved } from "./useStepsScrollPreserved";
import type { CustomFieldValueEntry, SpecCaseDetail, SpecTreeData, Step } from "../types";
import { authHeaders, jsonHeaders } from "../utils/session";

import { errorMessage } from "../api/errors";
export interface CaseEditorOptions {
  workspaceMode: "EXECUTION" | "SPECIFICATION";
  selectedProjectId: string;
  /** New cases go into the selected suite. */
  selectedSuiteId: string | null;
  specSelectedCaseId: string | null;
  setSpecSelectedCaseId: Dispatch<SetStateAction<string | null>>;
  specSelectedCaseIdRef: MutableRefObject<string | null>;
  specData: SpecTreeData | null;
  refreshSpecTree: () => Promise<void>;
  showDeprecated: boolean;
  showToast: (msg: string) => void;
  handleAuthExpiry: () => void;
  /** Re-runs the active search after a custom field value changes. */
  setFilterDataTick: Dispatch<SetStateAction<number>>;
  /** Bumped when an admin changes a custom field definition. */
  customFieldDefsVersion: number;
}

/**
 * Spec mode's test case editing: the selected case's details and custom field values,
 * editing its fields, summary, preconditions and steps (autosaved), the version lifecycle
 * (draft, approve, deprecate, restore), and creating and deleting cases.
 */
export function useCaseEditor({
  workspaceMode,
  selectedProjectId,
  selectedSuiteId,
  specSelectedCaseId,
  setSpecSelectedCaseId,
  specSelectedCaseIdRef,
  specData,
  refreshSpecTree,
  showDeprecated,
  showToast,
  handleAuthExpiry,
  setFilterDataTick,
  customFieldDefsVersion,
}: CaseEditorOptions) {
  const [specCaseDetail, setSpecCaseDetail] = useState<SpecCaseDetail | null>(
    null,
  );

  const [specCaseCustomFieldValues, setSpecCaseCustomFieldValues] = useState<
    CustomFieldValueEntry[] | null
  >(null);
  const [savingCustomFieldId, setSavingCustomFieldId] = useState<string | null>(null);
  const [customFieldErrorById, setCustomFieldErrorById] = useState<Record<string, string>>({});
  // Bumped per-definition when a save is rejected (e.g. a required field's value was cleared,
  // 422 REQUIRED_FIELD_MISSING) -- included in CustomFieldEditor's `key` (CaseDetailPane) so a rejected
  // edit forces a remount back to the last known-good value (specCaseCustomFieldValues was
  // never updated on failure, so it's still correct) instead of leaving the uncontrolled
  // input showing whatever invalid text the user typed, which never actually got saved. Without
  // this, a required field that a user cleared and failed to save still LOOKS blank even
  // though the real stored value is untouched -- easy to mistake for "the app let me approve
  // with an empty required field" when actually the field was quietly still holding its last
  // real value the whole time.
  const [customFieldResetKeyById, setCustomFieldResetKeyById] = useState<Record<string, number>>({});

  // Case create form (inline in Pane 2's header) and two-step delete confirmation for cases.
  const [isCaseCreateFormOpen, setIsCaseCreateFormOpen] = useState(false);
  const [newCaseTitle, setNewCaseTitle] = useState("");
  const [newCasePriority, setNewCasePriority] = useState("MEDIUM");
  const [newCaseExecutionType, setNewCaseExecutionType] = useState("MANUAL");
  const [isCreatingCase, setIsCreatingCase] = useState(false);
  const [deleteCasePrompt, setDeleteCasePrompt] = useState<{ id: string; detail: string } | null>(null);

  // Inline title/priority/execution_type editing on the case detail header -- always
  // editable regardless of version status, since these live on test_cases directly.

  // Draft-versioning: steps are edited as a local buffer while the latest version is
  // DRAFT, re-synced whenever the selected case or its version identity changes.
  const [stepsDraft, setStepsDraft] = useState<Step[]>([]);
  const [isCreatingDraft, setIsCreatingDraft] = useState(false);
  const [isApprovingVersion, setIsApprovingVersion] = useState(false);
  const [isTransitioningVersion, setIsTransitioningVersion] = useState(false);
  const [isSavingSteps, setIsSavingSteps] = useState(false);
  const [specEditError, setSpecEditError] = useState<string | null>(null);

  // Per-row refs for the step editor's Action textareas, keyed by index -- lets addStep()
  // focus the newly-added row's Action field once it exists in the DOM (see the
  // pendingStepFocusIndexRef effect below addStep).
  const stepActionRefs = useRef<Array<HTMLTextAreaElement | null>>([]);
  const pendingStepFocusIndexRef = useRef<number | null>(null);
  // Tracks the in-flight steps-save request (if any) -- see saveSteps' own comment for the
  // stale-save race this guards against between a field's blur-triggered save and a
  // Move/Remove's own save.
  const stepsSaveAbortRef = useRef<AbortController | null>(null);
  // The Spec-mode case detail pane's own scroll container (Summary/Preconditions/steps all
  // live inside it) -- see hooks/useStepsScrollPreserved.ts for why this needs tracking at all.
  const specDetailScrollRef = useRef<HTMLDivElement>(null);
  const stepsEndAnchorRef = useRef<HTMLDivElement>(null);
  const stepsScroll = useStepsScrollPreserved(specDetailScrollRef, stepsEndAnchorRef);

  // Lazy per-case detail (steps/preconditions) for whichever case is selected in
  // Specification mode -- kept out of the bulk spec-tree payload to stay light for large
  // projects.
  useEffect(() => {
    if (workspaceMode !== "SPECIFICATION" || !specSelectedCaseId) {
      setSpecCaseDetail(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/v1/test-cases/${specSelectedCaseId}/latest-version`, {
          headers: authHeaders(),
        });
        if (!cancelled) setSpecCaseDetail(res.ok ? await res.json() : null);
      } catch {
        if (!cancelled) setSpecCaseDetail(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceMode, specSelectedCaseId]);

  // Re-syncs the local steps-edit buffer whenever the selected case's latest version
  // changes identity (a new case selected, a new draft created, or an approve just
  // happened) -- only meaningful while that version is DRAFT; otherwise cleared.
  useEffect(() => {
    if (specCaseDetail?.version?.status === "DRAFT") {
      setStepsDraft(specCaseDetail.version.steps.map((s) => ({ ...s })));
    } else {
      setStepsDraft([]);
    }
    setSpecEditError(null);
  }, [specCaseDetail?.version?.id, specCaseDetail?.version?.status]);

  // Global admin-defined custom field values for whichever case is selected in
  // Specification mode -- fetched alongside specCaseDetail above, same lazy-per-case pattern.
  useEffect(() => {
    // customFieldErrorById is keyed only by definitionId, not by (case, definitionId) -- the
    // same field definition is shared across every case, so an error left over from a
    // rejected edit on the PREVIOUS case would otherwise still show here, against a field
    // that (on this case) was never touched at all. Clear it on every case switch so an
    // error message only ever reflects this case's own most recent save attempt.
    setCustomFieldErrorById({});
    if (workspaceMode !== "SPECIFICATION" || !specSelectedCaseId) {
      setSpecCaseCustomFieldValues(null);
      return;
    }
    // Clear synchronously before fetching the new case's values -- the editors (CaseDetailPane) are
    // uncontrolled (defaultValue-driven, see CustomFieldEditor.tsx), so if they were to stay
    // mounted showing the PREVIOUS case's still-current values while this fetch is in flight,
    // a later prop update once the fetch resolves would silently fail to update the already-
    // mounted DOM input's displayed value. Clearing first means there's nothing to show (or
    // stale) until the fresh data actually arrives.
    setSpecCaseCustomFieldValues(null);
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/v1/test-cases/${specSelectedCaseId}/custom-field-values`, {
          headers: authHeaders(),
        });
        if (!cancelled) setSpecCaseCustomFieldValues(res.ok ? (await res.json()).values : null);
      } catch {
        if (!cancelled) setSpecCaseCustomFieldValues(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceMode, specSelectedCaseId, customFieldDefsVersion]);

  // Commits one custom field value edit via PUT, then optimistically patches local state
  // so the field reflects the save without waiting on a full spec-tree/detail refetch.
  const handleCustomFieldValueChange = useCallback(
    async (definitionId: string, value: unknown) => {
      if (!specSelectedCaseId) return;
      const requestCaseId = specSelectedCaseId;
      setSavingCustomFieldId(definitionId);
      setCustomFieldErrorById((prev) => {
        const next = { ...prev };
        delete next[definitionId];
        return next;
      });
      try {
        const res = await fetch(
          `/api/v1/test-cases/${requestCaseId}/custom-field-values/${definitionId}`,
          {
            method: "PUT",
            headers: jsonHeaders(),
            body: JSON.stringify({ value }),
          },
        );
        const data = await res.json();
        if (!res.ok) {
          throw new Error(errorMessage(data) || "Failed to save custom field value");
        }
        setFilterDataTick((t) => t + 1);
        // The save genuinely succeeded against requestCaseId's own data regardless -- but if
        // the user has since navigated to a different case (e.g. a blur-triggered autosave
        // whose response arrives after the switch), specCaseCustomFieldValues now holds the
        // NEW case's values, and patching it here would silently overwrite that case's real
        // value with this now-irrelevant response. Skip the display update in that case.
        if (specSelectedCaseIdRef.current === requestCaseId) {
          setSpecCaseCustomFieldValues((prev) =>
            prev
              ? prev.map((entry) =>
                  entry.definition.id === definitionId ? { ...entry, value: data.value } : entry,
                )
              : prev,
          );
        }
      } catch (err: any) {
        setCustomFieldErrorById((prev) => ({
          ...prev,
          [definitionId]: err.message || "Failed to save",
        }));
        // Force the (uncontrolled) input back to the last known-good value -- see
        // customFieldResetKeyById's own comment for why this matters.
        setCustomFieldResetKeyById((prev) => ({ ...prev, [definitionId]: (prev[definitionId] ?? 0) + 1 }));
      } finally {
        setSavingCustomFieldId(null);
      }
    },
    [specSelectedCaseId],
  );

  const handleUpdateCaseField = useCallback(
    async (field: "title" | "priority" | "execution_type", value: string): Promise<boolean> => {
      if (!specSelectedCaseId || !selectedProjectId) return false;
      // Errors show in the case pane, like the other case edits (this one went into a state
      // nothing displayed, so a failed title/priority/type save went unnoticed).
      setSpecEditError(null);
      try {
        const res = await fetch(`/api/v1/projects/${selectedProjectId}/test-cases/${specSelectedCaseId}`, {
          method: "PUT",
          headers: jsonHeaders(),
          body: JSON.stringify({ [field]: value }),
        });
        const data = await res.json();
        if (!res.ok) {
          if (res.status === 401) {
            handleAuthExpiry();
            return false;
          }
          throw new Error(errorMessage(data) || "Failed to save");
        }
        await refreshSpecTree();
        return true;
      } catch (err: any) {
        setSpecEditError(err.message || "Failed to save");
        return false;
      }
    },
    [specSelectedCaseId, selectedProjectId, refreshSpecTree, handleAuthExpiry],
  );

  const handleCreateDraft = useCallback(async () => {
    if (!specSelectedCaseId || !selectedProjectId) return;
    setIsCreatingDraft(true);
    setSpecEditError(null);
    try {
      const res = await fetch(
        `/api/v1/projects/${selectedProjectId}/test-cases/${specSelectedCaseId}/versions/draft`,
        { method: "POST", headers: authHeaders() },
      );
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 401) {
          handleAuthExpiry();
          return;
        }
        throw new Error(errorMessage(data) || "Failed to create draft");
      }
      setSpecCaseDetail((prev) => (prev ? { ...prev, version: data.version } : prev));
      await refreshSpecTree();
    } catch (err: any) {
      setSpecEditError(err.message || "Failed to create draft");
    } finally {
      setIsCreatingDraft(false);
    }
  }, [specSelectedCaseId, selectedProjectId, refreshSpecTree, handleAuthExpiry]);

  const handleApproveVersion = useCallback(async () => {
    if (!selectedProjectId || !specCaseDetail?.version) return;
    setIsApprovingVersion(true);
    setSpecEditError(null);
    try {
      const res = await fetch(
        `/api/v1/projects/${selectedProjectId}/test-case-versions/${specCaseDetail.version.id}/approve`,
        { method: "POST", headers: authHeaders() },
      );
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 401) {
          handleAuthExpiry();
          return;
        }
        throw new Error(errorMessage(data) || "Failed to approve");
      }
      setSpecCaseDetail((prev) => (prev ? { ...prev, version: data.version } : prev));
      await refreshSpecTree();
    } catch (err: any) {
      setSpecEditError(err.message || "Failed to approve");
    } finally {
      setIsApprovingVersion(false);
    }
  }, [selectedProjectId, specCaseDetail, refreshSpecTree, handleAuthExpiry]);

  // Deprecate (APPROVED -> DEPRECATED) / Restore (DEPRECATED -> APPROVED) -- the lifecycle
  // button's other two states (see the case header). Same fetch/error/refresh shape as
  // handleApproveVersion.
  const handleVersionTransition = useCallback(
    async (transition: "deprecate" | "restore") => {
      if (!selectedProjectId || !specCaseDetail?.version) return;
      setIsTransitioningVersion(true);
      setSpecEditError(null);
      try {
        const res = await fetch(
          `/api/v1/projects/${selectedProjectId}/test-case-versions/${specCaseDetail.version.id}/${transition}`,
          { method: "POST", headers: authHeaders() },
        );
        const data = await res.json();
        if (!res.ok) {
          if (res.status === 401) {
            handleAuthExpiry();
            return;
          }
          throw new Error(errorMessage(data) || `Failed to ${transition}`);
        }
        setSpecCaseDetail((prev) => (prev ? { ...prev, version: data.version } : prev));
        await refreshSpecTree();
        // With "Show deprecated" off the case just left the list (and this pane) -- say where
        // it went rather than having it silently vanish.
        if (transition === "deprecate" && !showDeprecated) {
          showToast('Test case deprecated. Turn on "Show deprecated" to see or restore it.');
        }
      } catch (err: any) {
        setSpecEditError(err.message || `Failed to ${transition}`);
      } finally {
        setIsTransitioningVersion(false);
      }
    },
    [selectedProjectId, specCaseDetail, refreshSpecTree, handleAuthExpiry, showDeprecated, showToast],
  );

  const handleSaveVersionContent = useCallback(
    async (field: "summary" | "preconditions", value: string) => {
      if (!selectedProjectId || !specCaseDetail?.version) return;
      setSpecEditError(null);
      try {
        const res = await fetch(
          `/api/v1/projects/${selectedProjectId}/test-case-versions/${specCaseDetail.version.id}`,
          {
            method: "PUT",
            headers: jsonHeaders(),
            body: JSON.stringify({ [field]: value || null }),
          },
        );
        const data = await res.json();
        if (!res.ok) {
          if (res.status === 401) {
            handleAuthExpiry();
            return;
          }
          throw new Error(errorMessage(data) || "Failed to save");
        }
        setSpecCaseDetail((prev) => (prev ? { ...prev, version: data.version } : prev));
      } catch (err: any) {
        setSpecEditError(err.message || "Failed to save");
      }
    },
    [selectedProjectId, specCaseDetail, handleAuthExpiry],
  );

  // Steps autosave -- no explicit "Save Steps" button (per Elliot's request, matching the
  // Summary/Preconditions fields' existing silent-onBlur-save convention). Accepts an
  // optional explicit array so a structural change (remove/reorder) can save the freshly
  // computed array immediately rather than racing setStepsDraft's async state update --
  // stepsDraft itself is only safe to read from a blur handler, which fires after React
  // has already re-rendered with the latest onChange-driven state.
  const saveSteps = useCallback(
    async (stepsOverride?: Step[]) => {
      if (!selectedProjectId || !specCaseDetail?.version) return;
      const stepsToSave = stepsOverride ?? stepsDraft;
      // Abort any still-in-flight save before starting this one. Without this, a field's own
      // blur-triggered save (using stepsDraft as it was *before* a reorder/removal, since a
      // field's native blur fires before the Move/Remove button's own onClick even runs) can
      // still be in flight when moveStep/removeStep immediately fire their own save with the
      // freshly mutated array. With no cancellation, both requests hit the same PUT endpoint
      // and whichever happens to resolve last silently wins -- occasionally reverting the
      // user's reorder/removal back to the stale pre-mutation order. Aborting the previous
      // request here means only the most recently-started save can ever complete/apply.
      stepsSaveAbortRef.current?.abort();
      const controller = new AbortController();
      stepsSaveAbortRef.current = controller;
      setIsSavingSteps(true);
      setSpecEditError(null);
      try {
        const res = await fetch(
          `/api/v1/projects/${selectedProjectId}/test-case-versions/${specCaseDetail.version.id}`,
          {
            method: "PUT",
            headers: jsonHeaders(),
            body: JSON.stringify({
              steps: stepsToSave.map((s, i) => ({
                step_number: i + 1,
                action: s.action,
                expected_result: s.expected_result,
              })),
            }),
            signal: controller.signal,
          },
        );
        const data = await res.json();
        if (!res.ok) {
          if (res.status === 401) {
            handleAuthExpiry();
            return;
          }
          throw new Error(errorMessage(data) || "Failed to save steps");
        }
        setSpecCaseDetail((prev) => (prev ? { ...prev, version: data.version } : prev));
      } catch (err: any) {
        // A superseded save is expected/intentional, not a real failure -- don't surface it.
        if (err?.name === "AbortError") return;
        setSpecEditError(err.message || "Failed to save steps");
      } finally {
        // Only the still-current (non-superseded) call gets to clear the saving indicator --
        // an aborted stale call's finally would otherwise fire almost immediately (abort
        // rejects fast) and flip isSavingSteps back to false while the real, newer save is
        // still genuinely in flight.
        if (stepsSaveAbortRef.current === controller) {
          setIsSavingSteps(false);
        }
        // This setSpecCaseDetail/setIsSavingSteps commit is the second of the two scroll-
        // resetting commits described in useStepsScrollPreserved's comment -- schedule a
        // restore again here, not just at the call site, since that first restore alone gets
        // silently overwritten once this async save actually resolves.
        stepsScroll.scheduleRestore("restore");
      }
    },
    [selectedProjectId, specCaseDetail, stepsDraft, handleAuthExpiry, stepsScroll],
  );

  // moveStep/removeStep compute the next array from the current stepsDraft directly (rather
  // than via setStepsDraft's functional-updater form) specifically so that same array can
  // also be handed to saveSteps() as a plain, synchronous side effect outside of state
  // reconciliation -- a fetch triggered from inside a state updater callback would be an
  // impure side effect there (risky under React StrictMode's intentional double-invocation
  // of updaters) and updater functions don't have anywhere to hand `next` back out anyway.
  const moveStep = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= stepsDraft.length) return;
    stepsScroll.captureScroll();
    // The native click already focused this Move up/down button before this handler even
    // started (mousedown focuses synchronously, ahead of the click event). That focused
    // button's row is one of the two about to swap position -- blurring it here, before the
    // state update, means React's own commit-phase focus/selection preservation logic has
    // nothing focused left to "restore" a scroll position for, which is what was causing the
    // incorrect reset in the first place (see useStepsScrollPreserved's comment).
    stepsScroll.blurActiveElement();
    const next = [...stepsDraft];
    [next[index], next[target]] = [next[target], next[index]];
    setStepsDraft(next);
    stepsScroll.scheduleRestore("restore");
    saveSteps(next);
  };
  const updateStepField = (index: number, patch: Partial<Step>) => {
    setStepsDraft((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  };
  const removeStep = (index: number) => {
    stepsScroll.captureScroll();
    stepsScroll.blurActiveElement();
    const next = stepsDraft.filter((_, i) => i !== index);
    setStepsDraft(next);
    stepsScroll.scheduleRestore("restore");
    saveSteps(next);
  };
  const addStep = () => {
    // Blur whatever's currently focused (typically the "+Add Step" button itself, which
    // Chromium native-focuses on click before this handler runs -- Safari/Firefox-mac don't,
    // so this is a partial mitigation, not the full fix; see the useLayoutEffect below for
    // why the fix works regardless of browser) before mutating state, matching moveStep/
    // removeStep's existing pattern: React's commit-phase focus/selection restoration
    // (restoreSelection) engages whenever a mutation touches a subtree containing the
    // currently-focused node -- inserting the new row right before a still-focused button
    // qualifies -- and re-applies a snapshotted scroll offset that can land wrong. Blurring
    // first gives it nothing to "restore" for.
    stepsScroll.blurActiveElement();
    setStepsDraft((prev) => {
      pendingStepFocusIndexRef.current = prev.length;
      return [
        ...prev,
        { id: `new-${Date.now()}`, step_number: prev.length + 1, action: "", expected_result: "" },
      ];
    });
    // Unlike moveStep/removeStep (which restore the pane's *previous* scroll position -- see
    // useStepsScrollPreserved's comment), a new step is appended at the end of the list, so
    // "stay at the bottom" means scrolling further down to the new bottom.
    stepsScroll.scheduleRestore("scrollToBottom");
  };

  // Focuses the newly-added row's Action field once it actually exists in the DOM (the ref
  // doesn't exist yet during addStep() itself). Scroll placement itself is handled by
  // useStepsScrollPreserved's own layout effect (scheduled via scrollToBottom above, which
  // React batches into the same commit as the setStepsDraft call here) -- this effect only
  // owns focusing the specific new field, which the shared hook has no way to know about.
  // useLayoutEffect (not useEffect) deliberately, for the same reason: focusing before paint
  // means preventScroll's suppression of the browser's own native scroll-into-view pass is
  // never raced by an intermediate painted frame.
  useLayoutEffect(() => {
    if (pendingStepFocusIndexRef.current !== null) {
      const idx = pendingStepFocusIndexRef.current;
      pendingStepFocusIndexRef.current = null;
      // preventScroll: true stops the browser's own native "scroll focused element into
      // view" pass from running at all -- useStepsScrollPreserved's own scrollTop assignment
      // is the only thing that gets to move scroll.
      stepActionRefs.current[idx]?.focus({ preventScroll: true });
    }
  }, [stepsDraft.length]);

  // Case create
  const handleCreateCase = useCallback(async () => {
    if (!selectedProjectId || !selectedSuiteId || !newCaseTitle.trim()) return;
    setIsCreatingCase(true);
    try {
      const res = await fetch(`/api/v1/projects/${selectedProjectId}/test-cases`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          test_suite_id: selectedSuiteId,
          title: newCaseTitle,
          priority: newCasePriority,
          execution_type: newCaseExecutionType,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(errorMessage(data) || "Failed to create case");
      setNewCaseTitle("");
      setIsCaseCreateFormOpen(false);
      await refreshSpecTree();
      setSpecSelectedCaseId(data.test_case.id);
      showToast("Case created");
    } catch (err: any) {
      showToast(err.message || "Failed to create case");
    } finally {
      setIsCreatingCase(false);
    }
  }, [selectedProjectId, selectedSuiteId, newCaseTitle, newCasePriority, newCaseExecutionType, refreshSpecTree, showToast]);

  // Case delete (two-step confirmation)
  const handleDeleteCaseClick = useCallback(
    async (caseId: string) => {
      if (!selectedProjectId) return;
      try {
        const res = await fetch(`/api/v1/projects/${selectedProjectId}/test-cases/${caseId}`, {
          method: "DELETE",
          headers: authHeaders(),
        });
        if (res.status === 409) {
          const data = await res.json();
          setDeleteCasePrompt({ id: caseId, detail: data.detail || "This case has recorded plan links or executions." });
          return;
        }
        if (!res.ok && res.status !== 204) {
          const data = await res.json();
          throw new Error(errorMessage(data) || "Failed to delete case");
        }
        if (specSelectedCaseId === caseId) setSpecSelectedCaseId(null);
        showToast("Case deleted");
        await refreshSpecTree();
      } catch (err: any) {
        showToast(err.message || "Failed to delete case");
      }
    },
    [selectedProjectId, specSelectedCaseId, refreshSpecTree, showToast],
  );
  const handleConfirmDeleteCase = useCallback(async () => {
    if (!deleteCasePrompt || !selectedProjectId) return;
    try {
      const res = await fetch(
        `/api/v1/projects/${selectedProjectId}/test-cases/${deleteCasePrompt.id}?force=true`,
        { method: "DELETE", headers: authHeaders() },
      );
      if (!res.ok && res.status !== 204) {
        const data = await res.json();
        throw new Error(errorMessage(data) || "Failed to delete case");
      }
      if (specSelectedCaseId === deleteCasePrompt.id) setSpecSelectedCaseId(null);
      setDeleteCasePrompt(null);
      showToast("Case and its history deleted");
      await refreshSpecTree();
    } catch (err: any) {
      showToast(err.message || "Failed to delete case");
    }
  }, [deleteCasePrompt, selectedProjectId, specSelectedCaseId, refreshSpecTree, showToast]);

  const specActiveCase = specData?.cases.find((c) => c.id === specSelectedCaseId) || null;
  const specVersionDetail = specCaseDetail?.version || null;

  return {
    specCaseDetail,
    setSpecCaseDetail,
    specCaseCustomFieldValues,
    setSpecCaseCustomFieldValues,
    savingCustomFieldId,
    setSavingCustomFieldId,
    customFieldErrorById,
    setCustomFieldErrorById,
    customFieldResetKeyById,
    setCustomFieldResetKeyById,
    isCaseCreateFormOpen,
    setIsCaseCreateFormOpen,
    newCaseTitle,
    setNewCaseTitle,
    newCasePriority,
    setNewCasePriority,
    newCaseExecutionType,
    setNewCaseExecutionType,
    isCreatingCase,
    setIsCreatingCase,
    deleteCasePrompt,
    setDeleteCasePrompt,
    stepsDraft,
    setStepsDraft,
    isCreatingDraft,
    setIsCreatingDraft,
    isApprovingVersion,
    setIsApprovingVersion,
    isTransitioningVersion,
    setIsTransitioningVersion,
    isSavingSteps,
    setIsSavingSteps,
    specEditError,
    setSpecEditError,
    stepActionRefs,
    pendingStepFocusIndexRef,
    stepsSaveAbortRef,
    specDetailScrollRef,
    stepsEndAnchorRef,
    stepsScroll,
    handleCustomFieldValueChange,
    handleUpdateCaseField,
    handleCreateDraft,
    handleApproveVersion,
    handleVersionTransition,
    handleSaveVersionContent,
    saveSteps,
    moveStep,
    updateStepField,
    removeStep,
    addStep,
    handleCreateCase,
    handleDeleteCaseClick,
    handleConfirmDeleteCase,
    specActiveCase,
    specVersionDetail,
  };
}

export type CaseEditor = ReturnType<typeof useCaseEditor>;
