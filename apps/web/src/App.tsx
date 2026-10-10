import React, { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import { useHotkeyEngine } from "./hooks/useHotkeyEngine";
import { nextExecutionCaseIndex } from "./utils/executionCaseOrder";
import { TestCaseQueueGrid } from "./components/TestCaseQueueGrid";
import {
  VirtualizedSuiteTree,
  SuiteTreeNode,
} from "./components/VirtualizedSuiteTree";
import {
  SpecCaseListGrid,
  SpecCaseGridItem,
} from "./components/SpecCaseListGrid";
import { AuthModal } from "./components/AuthModal";
import { AdminPanelModal } from "./components/AdminPanelModal";
import { ImportWizardModal } from "./components/ImportWizardModal";
import { ExportModal } from "./components/ExportModal";
import { ReportsView, parseReportsHash } from "./components/reports/ReportsView";
import { LoginPage } from "./components/LoginPage";
import { ForcedPasswordChange } from "./components/ForcedPasswordChange";
import { CustomFieldEditor } from "./components/CustomFieldEditor";
import { CaseFilterPanel } from "./components/CaseFilterPanel";
import { EntityManagementModal } from "./components/EntityManagementModal";
import { authHeaders, jsonHeaders } from "./utils/session";
import type {
  CustomFieldValueEntry,
  SpecCaseDetail,
  SpecTreeData,
  Step,
} from "./types";
import { OVERWRITE_DENIED_MESSAGE, RUN_DENIED_MESSAGE } from "./app/messages";
import { autoGrowTextarea } from "./utils/autoGrowTextarea";
import { permissionFlags } from "./utils/permissions";
import {
  buildSuiteNodes,
  expandableSuiteIds as listExpandableSuiteIds,
  findSuiteNode,
  flattenSuiteOptions,
  pruneSuiteTree,
  rangeBetween,
  suiteInfoById as buildSuiteInfoById,
  visibleSuiteOrder as listVisibleSuiteOrder,
} from "./utils/suiteTree";
import { useStepsScrollPreserved } from "./hooks/useStepsScrollPreserved";
import { usePaneLayout } from "./hooks/usePaneLayout";
import { useSession } from "./hooks/useSession";
import { useToast } from "./hooks/useToast";
import { useScope } from "./hooks/useScope";
import { AppProvider, type AppContextValue } from "./app/AppContext";
import { AppHeader } from "./components/layout/AppHeader";
import { StatusBanners } from "./components/layout/StatusBanners";
import { ExecutionPane } from "./components/execute/ExecutionPane";
import { useExecutionWorkspace } from "./hooks/useExecutionWorkspace";
import { useCaseSearch } from "./hooks/useCaseSearch";
import { useExecution } from "./hooks/useExecution";

/** A Reports link (#/reports/...) opened directly: the view, tab and scope to start on. */
const INITIAL_REPORTS_LINK = typeof window !== "undefined" ? parseReportsHash(window.location.hash) : null;

export default function App() {
  // Bumped when an admin creates, changes or deletes a custom field definition (Admin Panel),
  // so the open case's/suite's values and the filter's field list reload instead of showing
  // what they showed before the change.
  const [customFieldDefsVersion, setCustomFieldDefsVersion] = useState(0);
  // Spec mode: deprecated cases are hidden from the case list (and tree counts) unless this is
  // on -- passed to GET .../spec-tree as include_deprecated. Session-only.
  const [showDeprecated, setShowDeprecated] = useState(false);
  // Suite tree expand/collapse (suite id -> expanded; a missing id means expanded). Owned here
  // so the filter panel's "Expand all"/"Collapse all" can drive it. Session-only.
  const [suiteExpandedMap, setSuiteExpandedMap] = useState<Record<string, boolean>>({});
  // Spec-mode multi-select (Shift = range, Ctrl/Cmd = toggle) and drag-and-drop moving. A
  // selection lives in one list at a time; the anchors are where a Shift-range starts.
  const [specSelectedSuiteIds, setSpecSelectedSuiteIds] = useState<Set<string>>(() => new Set());
  const [specSelectedCaseIds, setSpecSelectedCaseIds] = useState<Set<string>>(() => new Set());
  const suiteSelectAnchorRef = useRef<string | null>(null);
  const caseSelectAnchorRef = useRef<string | null>(null);
  const [dragPayload, setDragPayload] = useState<{ kind: "SUITES" | "CASES"; ids: string[] } | null>(null);
  const { toastMessage, showToast } = useToast();

  const { suiteTreeWidth, queueGridWidth, setHoveredDivider, handleDividerMouseDown, dividerStyle } = usePaneLayout();

  // Specification / Execution mode toggle (Pane 1 header) & Specification-mode state
  const [workspaceMode, setWorkspaceMode] = useState<"EXECUTION" | "SPECIFICATION">(
    "SPECIFICATION",
  );
  const [specData, setSpecData] = useState<SpecTreeData | null>(null);
  const [selectedSuiteId, setSelectedSuiteId] = useState<string | null>(null);
  // Execute mode's own suite selection -- narrows the queue grid to that suite's cases. Kept
  // separate from selectedSuiteId (Spec mode's, which also drives Pane 3's Suite Details) so
  // browsing suites in Spec mode never silently narrows the execution queue, or vice versa.
  // Clicking the selected suite again (or the ✕ in the queue header) clears it.
  const [execSuiteFilterId, setExecSuiteFilterId] = useState<string | null>(null);
  // Mirrors selectedSuiteId for reads from inside an already-in-flight async closure (see
  // handleSuiteCustomFieldValueChange) -- same race this file already guards against for
  // specSelectedCaseIdRef below, just for the suite-details custom fields instead.
  const selectedSuiteIdRef = useRef<string | null>(null);
  useEffect(() => {
    selectedSuiteIdRef.current = selectedSuiteId;
  }, [selectedSuiteId]);
  const [specSelectedCaseId, setSpecSelectedCaseId] = useState<string | null>(
    null,
  );
  // Mirrors specSelectedCaseId for reads from inside an already-in-flight async closure (see
  // handleCustomFieldValueChange) -- a blur-triggered custom-field autosave for a case the
  // user has since navigated away from must not let its late-arriving response patch the
  // now-different case's displayed values.
  const specSelectedCaseIdRef = useRef<string | null>(null);
  useEffect(() => {
    specSelectedCaseIdRef.current = specSelectedCaseId;
  }, [specSelectedCaseId]);
  const [specCaseDetail, setSpecCaseDetail] = useState<SpecCaseDetail | null>(
    null,
  );
  const [pendingToggleId, setPendingToggleId] = useState<string | null>(null);
  const [specCaseCustomFieldValues, setSpecCaseCustomFieldValues] = useState<
    CustomFieldValueEntry[] | null
  >(null);
  const [savingCustomFieldId, setSavingCustomFieldId] = useState<string | null>(null);
  const [customFieldErrorById, setCustomFieldErrorById] = useState<Record<string, string>>({});
  // Bumped per-definition when a save is rejected (e.g. a required field's value was cleared,
  // 422 REQUIRED_FIELD_MISSING) -- included in CustomFieldEditor's `key` below so a rejected
  // edit forces a remount back to the last known-good value (specCaseCustomFieldValues was
  // never updated on failure, so it's still correct) instead of leaving the uncontrolled
  // input showing whatever invalid text the user typed, which never actually got saved. Without
  // this, a required field that a user cleared and failed to save still LOOKS blank even
  // though the real stored value is untouched -- easy to mistake for "the app let me approve
  // with an empty required field" when actually the field was quietly still holding its last
  // real value the whole time.
  const [customFieldResetKeyById, setCustomFieldResetKeyById] = useState<Record<string, number>>({});
  // Suite-level custom field values for whichever suite is selected in Specification mode --
  // shown/edited in Pane 3's Suite Details view (see specActiveCase/selectedSuiteId below).
  // Same shape as specCaseCustomFieldValues above: clear-before-fetch discipline (the editors
  // are uncontrolled) and a savingId/errorById/resetKeyById set per field.
  const [suiteCustomFieldValues, setSuiteCustomFieldValues] = useState<
    CustomFieldValueEntry[] | null
  >(null);
  const [savingSuiteCustomFieldId, setSavingSuiteCustomFieldId] = useState<string | null>(null);
  const [suiteCustomFieldErrorById, setSuiteCustomFieldErrorById] = useState<Record<string, string>>({});
  const [suiteCustomFieldResetKeyById, setSuiteCustomFieldResetKeyById] = useState<Record<string, number>>({});

  // Suite create/rename form (inline, not a modal).
  const [suiteFormState, setSuiteFormState] = useState<{
    mode: "CREATE" | "RENAME";
    targetId: string | null; // the suite being renamed (RENAME) or the parent to create under (CREATE, may be null for top-level)
    name: string;
    description: string;
    parentSuiteId: string | null;
  } | null>(null);
  const [isSavingSuiteForm, setIsSavingSuiteForm] = useState(false);

  // Two-step delete confirmation for suites -- mirrors AdminPanelModal's deleteFieldPrompt.
  const [deleteSuitePrompt, setDeleteSuitePrompt] = useState<{ id: string; detail: string } | null>(null);

  // Removing a case (or a suite's cases) that already has results asks first: the server
  // explains how many results it has; confirming retires it from the plan, keeping them.
  const [removeFromPlanPrompt, setRemoveFromPlanPrompt] = useState<{ kind: "case" | "suite"; id: string; detail: string } | null>(null);

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

  // Authentication & RBAC User State
  const {
    currentUser,
    setCurrentUser,
    userPermissions,
    setUserPermissions,
    sessionEndedNotice,
    setSessionEndedNotice,
    authChecking,
    fetchCurrentUser,
    handleLogout,
    handleAuthExpiry,
  } = useSession(showToast);
  const [authModalOpen, setAuthModalOpen] = useState<boolean>(false);
  const [adminPanelOpen, setAdminPanelOpen] = useState<boolean>(false);
  const [importWizardOpen, setImportWizardOpen] = useState<boolean>(false);
  const [exportModalOpen, setExportModalOpen] = useState<boolean>(false);
  // The Reports view replaces the three panes while open (the header stays as its scope).
  const [appView, setAppView] = useState<"WORKSPACE" | "REPORTS">(INITIAL_REPORTS_LINK ? "REPORTS" : "WORKSPACE");
  // Leaving Reports drops its #/reports/... link from the address bar (the view keeps the hash
  // in sync while it's open, so the address is always a link to the report on screen).
  useEffect(() => {
    if (appView !== "REPORTS" && window.location.hash.startsWith("#/reports")) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    }
  }, [appView]);

  // The Project / Plan / Run being worked in (hooks/useScope.ts).
  const scope = useScope({
    currentUser,
    showToast,
    handleAuthExpiry,
    initial: { projectId: INITIAL_REPORTS_LINK?.project, planId: INITIAL_REPORTS_LINK?.plan, runId: INITIAL_REPORTS_LINK?.run },
    onProjectSwitched: () => {
      setSelectedSuiteId(null);
      setExecSuiteFilterId(null);
      setSpecSelectedCaseId(null);
    },
  });
  const {
    projectsList,
    selectedProjectId,
    plansList,
    selectedPlanId,
    setSelectedPlanId,
    runsList,
    isTogglingRun,
    selectedRunId,
    selectedRun,
    entityModalOpen,
    setEntityModalOpen,
    modalEntityType,
    modalActionType,
    modalSelectedItem,
    handleSaveEntity,
    refreshRunsList,
    handleToggleRunClosed,
  } = scope;

  // The selected plan's cases for Execute mode (hooks/useExecutionWorkspace.ts).
  const executionWorkspace = useExecutionWorkspace(scope);
  const { workspace, refreshExecutionWorkspace } = executionWorkspace;
  // The remove-from-plan confirmation acts on the selected plan -- drop it if that changes.
  useEffect(() => setRemoveFromPlanPrompt(null), [selectedPlanId]);


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
  // live inside it) -- see useStepsScrollPreserved above for why this needs tracking at all.
  const specDetailScrollRef = useRef<HTMLDivElement>(null);
  const stepsEndAnchorRef = useRef<HTMLDivElement>(null);
  const stepsScroll = useStepsScrollPreserved(specDetailScrollRef, stepsEndAnchorRef);


  // Guard against out-of-order fetch responses: switching project or plan (and the initial
  // load picking them) can fire several requests in quick succession. Without this, a
  // slower, now-stale response can resolve after a newer one and silently overwrite fresh data.
  const specTreeRequestSeq = useRef(0);

  // Spec-mode multi-select resets on mode/project change; Escape clears it (outside inputs).
  useEffect(() => {
    setSpecSelectedSuiteIds(new Set());
    setSpecSelectedCaseIds(new Set());
  }, [workspaceMode, selectedProjectId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")) return;
      setSpecSelectedSuiteIds(new Set());
      setSpecSelectedCaseIds(new Set());
    };
    // A virtualized source row can unmount mid-drag (its own dragend never fires), so any
    // drag ending anywhere also clears the drag state.
    const onDragEnd = () => setTimeout(() => setDragPayload(null), 0);
    window.addEventListener("keydown", onKey);
    window.addEventListener("dragend", onDragEnd);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("dragend", onDragEnd);
    };
  }, []);

  // Search & filter (hooks/useCaseSearch.ts).
  const {
    caseFilter,
    setCaseFilter,
    caseFilterFields,
    filterResult,
    filterError,
    setFilterDataTick,
    loadCaseFilterFields,
    searchInputRef,
  } = useCaseSearch({
    selectedProjectId,
    selectedPlanId,
    selectedRunId,
    workspaceMode,
    specData,
    workspace,
    customFieldDefsVersion,
  });





  // Specification-mode data: the whole project's suite/case spec, annotated with the
  // selected plan's inclusion state. Also drives Pane 1's suite tree in BOTH modes (see
  // suiteNodes below), fixing the tree's pre-existing flat/fake-count display.
  const refreshSpecTree = useCallback(async () => {
    // plan_id is genuinely optional on this route (apps/server/src/routes/testPlanCases.ts) --
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
      const params = new URLSearchParams();
      if (selectedPlanId) params.set("plan_id", selectedPlanId);
      if (showDeprecated) params.set("include_deprecated", "true");
      const qs = params.toString();
      const url = `/api/v1/projects/${selectedProjectId}/spec-tree${qs ? `?${qs}` : ""}`;
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
          include
            ? `/api/v1/test-plans/${selectedPlanId}/cases`
            : `/api/v1/test-plans/${selectedPlanId}/cases/${testCaseId}${force ? "?force=true" : ""}`,
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
          showToast(`🔒 ${body.detail || body.error || "Could not update plan membership"}`);
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
        const res = await fetch(
          `/api/v1/test-plans/${selectedPlanId}/suites/${suiteId}/cascade`,
          {
            method: "POST",
            headers: jsonHeaders(),
            body: JSON.stringify({ action, ...(force ? { force: true } : {}) }),
          },
        );
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
          showToast(`🔒 ${body.detail || body.error || "Could not update plan membership"}`);
        }
      } catch {
        showToast("Network error updating plan membership");
      } finally {
        setPendingToggleId(null);
      }
    },
    [selectedPlanId, showToast, refreshSpecTree],
  );

  // Build the real, nested SuiteTreeNode hierarchy from the Specification-mode spec-tree
  // fetch, which drives Pane 1 in BOTH modes (fixes the tree's pre-existing flat/fake-count
  // display). Execution mode's pass/fail counts are computed per-suite from the current
  // plan's cases (workspace.cases); Specification mode's in-plan/total counts come straight
  // from the server (spec-tree already sums them recursively over each subtree).
  const execCountsBySuite = new Map<string, { passed: number; total: number }>();
  if (workspaceMode === "EXECUTION") {
    for (const c of workspace.cases) {
      if (!c.test_suite_id) continue;
      const entry = execCountsBySuite.get(c.test_suite_id) || { passed: 0, total: 0 };
      entry.total += 1;
      if (c.latest_verdict === "PASSED") entry.passed += 1;
      execCountsBySuite.set(c.test_suite_id, entry);
    }
  }

  // With a search/filter active the tree only shows suites containing a match (plus their
  // ancestors, which suite_ids already includes) -- counts stay the suite's real totals.
  const suiteNodes: SuiteTreeNode[] = specData
    ? buildSuiteNodes(filterResult ? pruneSuiteTree(specData.suites, filterResult.suiteIds) : specData.suites, execCountsBySuite)
    : [];

  // Execute mode: the active case, notes, recording results and queue order (hooks/useExecution.ts).
  const execution = useExecution({
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
  });
  const {
    selectedIndex,
    setSelectedIndex,
    syncStatus,
    setShowStepDrawer,
    executionDenied,
    setExecutionDenied,
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
    passedCount,
    failedCount,
  } = execution;






  // The actual workspace data fetch: Specification mode always needs the spec tree (it also
  // drives Pane 1's suite tree in BOTH modes -- see suiteNodes below). The Run dropdown's
  // data is a three-way split: Execution mode needs the full execution queue (which carries
  // the plan's builds "for free" alongside it), Specification mode has no use for that queue
  // but still needs the Run dropdown itself kept correct (it's part of the shared header, not
  // mode-gated), so it gets the lighter builds-only fetch instead -- see refreshRunsList's own
  // comment for why this split exists.
  useEffect(() => {
    // refreshSpecTree itself now tolerates no plan being selected (see its own comment);
    // refreshExecutionWorkspace/refreshRunsList both self-guard on selectedPlanId, so it's
    // safe to always attempt all of these here and let each decide what it can actually do.
    if (!currentUser || !selectedProjectId) return;
    refreshSpecTree();
    if (workspaceMode === "EXECUTION") {
      refreshExecutionWorkspace();
    } else {
      refreshRunsList();
    }
  }, [
    currentUser,
    workspaceMode,
    selectedProjectId,
    selectedPlanId,
    refreshSpecTree,
    refreshExecutionWorkspace,
    refreshRunsList,
  ]);


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
    // Clear synchronously before fetching the new case's values -- the editors below are
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
          throw new Error(data.detail || data.error || "Failed to save custom field value");
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

  // Global admin-defined custom field values for whichever suite is selected in
  // Specification mode -- backs Pane 3's Suite Details view. Same lazy-per-entity,
  // clear-before-fetch pattern as specCaseCustomFieldValues above.
  useEffect(() => {
    // Same fix as customFieldErrorById above -- keyed only by definitionId, so it must be
    // cleared on every suite switch or a rejected edit's error would keep showing against a
    // different suite's otherwise-untouched field.
    setSuiteCustomFieldErrorById({});
    if (workspaceMode !== "SPECIFICATION" || !selectedSuiteId) {
      setSuiteCustomFieldValues(null);
      return;
    }
    setSuiteCustomFieldValues(null);
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/v1/test-suites/${selectedSuiteId}/custom-field-values`, {
          headers: authHeaders(),
        });
        if (!cancelled) setSuiteCustomFieldValues(res.ok ? (await res.json()).values : null);
      } catch {
        if (!cancelled) setSuiteCustomFieldValues(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceMode, selectedSuiteId, customFieldDefsVersion]);

  // Commits one suite custom field value edit via PUT -- mirrors handleCustomFieldValueChange
  // above exactly, including the same stale-response race guard (selectedSuiteIdRef).
  const handleSuiteCustomFieldValueChange = useCallback(
    async (definitionId: string, value: unknown) => {
      if (!selectedSuiteId) return;
      const requestSuiteId = selectedSuiteId;
      setSavingSuiteCustomFieldId(definitionId);
      setSuiteCustomFieldErrorById((prev) => {
        const next = { ...prev };
        delete next[definitionId];
        return next;
      });
      try {
        const res = await fetch(
          `/api/v1/test-suites/${requestSuiteId}/custom-field-values/${definitionId}`,
          {
            method: "PUT",
            headers: jsonHeaders(),
            body: JSON.stringify({ value }),
          },
        );
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.detail || data.error || "Failed to save custom field value");
        }
        setFilterDataTick((t) => t + 1);
        if (selectedSuiteIdRef.current === requestSuiteId) {
          setSuiteCustomFieldValues((prev) =>
            prev
              ? prev.map((entry) =>
                  entry.definition.id === definitionId ? { ...entry, value: data.value } : entry,
                )
              : prev,
          );
        }
      } catch (err: any) {
        setSuiteCustomFieldErrorById((prev) => ({
          ...prev,
          [definitionId]: err.message || "Failed to save",
        }));
        setSuiteCustomFieldResetKeyById((prev) => ({ ...prev, [definitionId]: (prev[definitionId] ?? 0) + 1 }));
      } finally {
        setSavingSuiteCustomFieldId(null);
      }
    },
    [selectedSuiteId],
  );

  // ---- Suite/case create/edit/delete (Specification mode) ----

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
          throw new Error(data.error || data.detail || "Failed to save");
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
        throw new Error(data.error || data.detail || "Failed to create draft");
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
        throw new Error(data.error || data.detail || "Failed to approve");
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
          throw new Error(data.detail || data.error || `Failed to ${transition}`);
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
          throw new Error(data.error || data.detail || "Failed to save");
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
          throw new Error(data.error || data.detail || "Failed to save steps");
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

  // Suite create/rename form
  const openCreateSuiteForm = (parentSuiteId: string | null) => {
    setSuiteFormState({ mode: "CREATE", targetId: parentSuiteId, name: "", description: "", parentSuiteId });
  };
  const openRenameSuiteForm = (suiteId: string, currentName: string, currentParentId: string | null) => {
    setSuiteFormState({ mode: "RENAME", targetId: suiteId, name: currentName, description: "", parentSuiteId: currentParentId });
  };
  const handleSaveSuiteForm = useCallback(async () => {
    if (!suiteFormState || !selectedProjectId) return;
    setIsSavingSuiteForm(true);
    try {
      const isCreate = suiteFormState.mode === "CREATE";
      const url = isCreate
        ? `/api/v1/projects/${selectedProjectId}/test-suites`
        : `/api/v1/projects/${selectedProjectId}/test-suites/${suiteFormState.targetId}`;
      const res = await fetch(url, {
        method: isCreate ? "POST" : "PUT",
        headers: jsonHeaders(),
        body: JSON.stringify({
          name: suiteFormState.name,
          description: suiteFormState.description || null,
          parent_suite_id: isCreate ? suiteFormState.parentSuiteId : suiteFormState.parentSuiteId,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.detail || "Failed to save suite");
      setSuiteFormState(null);
      showToast(isCreate ? "Suite created" : "Suite updated");
      await refreshSpecTree();
    } catch (err: any) {
      showToast(err.message || "Failed to save suite");
    } finally {
      setIsSavingSuiteForm(false);
    }
  }, [suiteFormState, selectedProjectId, refreshSpecTree, showToast]);

  // Renames a suite directly from Pane 3's Suite Details view -- a lighter always-editable
  // input (onBlur-save, matching the case title editor's pattern) rather than routing through
  // the fuller rename+move form above (still reachable via the tree's own rename icon, which
  // also lets you change the parent suite -- this one only ever touches the name).
  const handleUpdateSuiteName = useCallback(
    async (suiteId: string, name: string): Promise<boolean> => {
      if (!selectedProjectId) return false;
      try {
        const res = await fetch(`/api/v1/projects/${selectedProjectId}/test-suites/${suiteId}`, {
          method: "PUT",
          headers: jsonHeaders(),
          body: JSON.stringify({ name }),
        });
        const data = await res.json();
        if (!res.ok) {
          if (res.status === 401) {
            handleAuthExpiry();
            return false;
          }
          throw new Error(data.error || data.detail || "Failed to rename suite");
        }
        await refreshSpecTree();
        return true;
      } catch (err: any) {
        showToast(err.message || "Failed to rename suite");
        return false;
      }
    },
    [selectedProjectId, refreshSpecTree, showToast, handleAuthExpiry],
  );

  // Suite delete (two-step confirmation)
  const handleDeleteSuiteClick = useCallback(
    async (suiteId: string) => {
      if (!selectedProjectId) return;
      try {
        const res = await fetch(`/api/v1/projects/${selectedProjectId}/test-suites/${suiteId}`, {
          method: "DELETE",
          headers: authHeaders(),
        });
        if (res.status === 409) {
          const data = await res.json();
          setDeleteSuitePrompt({ id: suiteId, detail: data.detail || "This suite still contains content." });
          return;
        }
        if (!res.ok && res.status !== 204) {
          const data = await res.json();
          throw new Error(data.error || "Failed to delete suite");
        }
        if (selectedSuiteId === suiteId) setSelectedSuiteId(null);
        showToast("Suite deleted");
        await refreshSpecTree();
      } catch (err: any) {
        showToast(err.message || "Failed to delete suite");
      }
    },
    [selectedProjectId, selectedSuiteId, refreshSpecTree, showToast],
  );
  const handleConfirmDeleteSuite = useCallback(async () => {
    if (!deleteSuitePrompt || !selectedProjectId) return;
    try {
      const res = await fetch(
        `/api/v1/projects/${selectedProjectId}/test-suites/${deleteSuitePrompt.id}?force=true`,
        { method: "DELETE", headers: authHeaders() },
      );
      if (!res.ok && res.status !== 204) {
        const data = await res.json();
        throw new Error(data.error || "Failed to delete suite");
      }
      if (selectedSuiteId === deleteSuitePrompt.id) setSelectedSuiteId(null);
      setDeleteSuitePrompt(null);
      showToast("Suite and its contents deleted");
      await refreshSpecTree();
    } catch (err: any) {
      showToast(err.message || "Failed to delete suite");
    }
  }, [deleteSuitePrompt, selectedProjectId, selectedSuiteId, refreshSpecTree, showToast]);

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
      if (!res.ok) throw new Error(data.error || data.detail || "Failed to create case");
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
          throw new Error(data.error || "Failed to delete case");
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
        throw new Error(data.error || "Failed to delete case");
      }
      if (specSelectedCaseId === deleteCasePrompt.id) setSpecSelectedCaseId(null);
      setDeleteCasePrompt(null);
      showToast("Case and its history deleted");
      await refreshSpecTree();
    } catch (err: any) {
      showToast(err.message || "Failed to delete case");
    }
  }, [deleteCasePrompt, selectedProjectId, specSelectedCaseId, refreshSpecTree, showToast]);



  // Cases visible in Pane 2 for Specification mode: the whole project, or just the
  // currently selected suite's direct cases if one is selected in the tree.
  const specCasesForSuite: SpecCaseGridItem[] = specData
    ? specData.cases.filter(
        (c) =>
          (!selectedSuiteId || c.test_suite_id === selectedSuiteId) &&
          (!filterResult || filterResult.caseIds.has(c.id)),
      )
    : [];


  // Global Hotkey Engine Hook wiring. j/k/[/]//  stay valid in both modes; p/f/b/s
  // (verdict recording) are disabled in Specification mode -- see useHotkeyEngine's
  // `mode` option.
  useHotkeyEngine({
    fsm,
    disabled: appView === "REPORTS",
    mode: workspaceMode,
    caseCount:
      workspaceMode === "SPECIFICATION"
        ? specCasesForSuite.length
        : queueCaseIndices.length,
    selectedIndex:
      workspaceMode === "SPECIFICATION"
        ? specCasesForSuite.findIndex((c) => c.id === specSelectedCaseId)
        : selectedVisiblePos,
    onSelectIndex: (idx) => {
      if (workspaceMode === "SPECIFICATION") {
        const target = specCasesForSuite[idx];
        if (target) setSpecSelectedCaseId(target.id);
      } else {
        const target = queueCaseIndices[idx];
        if (target !== undefined) setSelectedIndex(target);
      }
    },
    onVerdict: (verdict) => {
      submitVerdict(verdict);
      // Always track the verdict just recorded, not just FAILED/BLOCKED -- a subsequent
      // note-only Ctrl+Enter (e.g. pressing 's' via hotkey, which doesn't auto-advance,
      // then typing a note) must resubmit with that same verdict, not a stale/default one.
      // Only FAILED/BLOCKED additionally auto-focus notes -- Pass/Skip stay quick actions.
      pendingVerdictRef.current = verdict;
      if (verdict === "FAILED" || verdict === "BLOCKED") {
        setTimeout(() => {
          if (notesInputRef.current) notesInputRef.current.focus();
        }, 50);
      }
    },
    onSubmitNotes: (notesText) => {
      // Submit with whatever verdict (FAILED or BLOCKED) the notes were opened for -- not
      // hardcoded FAILED, so pressing 'b' then Ctrl+Enter stays BLOCKED. No need to clear
      // failureNotes here -- the case-load effect below re-syncs it from the (about to
      // change) active case either way, whether that's this case's now-saved note or the
      // next case's own note after advancing.
      submitVerdict(pendingVerdictRef.current, notesText);
      notesDirtyRef.current = false;
      // Advance by suite-tree order, not raw array order -- finishing the last case in a
      // folder jumps straight to the first case in the next folder that has one, skipping
      // empty folders with no special-casing needed; finishing the very last case overall
      // wraps around to the first case in the first folder instead of just stopping.
      // If the active case is hidden by a search/filter it isn't in the order at all --
      // jump to the first visible case instead of doing nothing.
      const nextIdx =
        nextExecutionCaseIndex(executionCaseOrderByCaseIndex, selectedIndex) ??
        (executionCaseOrderByCaseIndex.includes(selectedIndex) ? null : executionCaseOrderByCaseIndex[0] ?? null);
      if (nextIdx !== null) advanceToCase(nextIdx);
    },
    // 'p'/'s' on the last case of a suite-narrowed queue: move into the next suite.
    onAdvancePastEnd: () => {
      if (crossSuiteNextCaseIndex !== undefined) advanceToCase(crossSuiteNextCaseIndex);
    },
    onToggleStepDrawer: () => setShowStepDrawer((prev) => !prev),
    onToggleSuiteExpand: () => {
      showToast("Toggled suite folder tree state ([ / ])");
    },
    onFocusSearch: () => {
      if (searchInputRef.current) searchInputRef.current.focus();
    },
    onPermissionDeniedToast: (msg) => {
      // No permission to record results at all: the same yellow banner as a server refusal.
      if (msg.includes("EXECUTE_RUN")) setExecutionDenied(RUN_DENIED_MESSAGE);
      else if (msg.includes("EXECUTE_OVERWRITE")) setExecutionDenied(OVERWRITE_DENIED_MESSAGE);
      else showToast(msg);
    },
    blockVerdictsReason: verdictBlockReason ?? undefined,
    notesInputRef,
  });


  const can = permissionFlags(userPermissions);
  const {
    hasRunManagePermission,
    hasPlanManagePermission,
    hasSpecCreatePermission,
    hasSpecEditPermission,
    hasSpecApprovePermission,
    hasSpecDeletePermission,
    hasSpecViewPermission,
    hasReportEmailPermission,
  } = can;
  // Someone who can run tests but not view the spec works in Execute mode only.
  const canViewSpec = hasSpecViewPermission;
  useEffect(() => {
    if (currentUser && !canViewSpec && workspaceMode === "SPECIFICATION") {
      setWorkspaceMode("EXECUTION");
    }
  }, [currentUser, canViewSpec, workspaceMode]);

  if (authChecking) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          backgroundColor: "#090d16",
          color: "#9ca3af",
          fontFamily: "Inter, sans-serif",
          fontSize: "14px",
        }}
      >
        ⚡ Initializing Testify...
      </div>
    );
  }

  if (!currentUser) {
    return (
      <LoginPage
        notice={sessionEndedNotice}
        onLoginSuccess={(user) => {
          setSessionEndedNotice(null);
          setCurrentUser(user);
          setUserPermissions(user.permissions || []);
          showToast(`Welcome back, ${user.username}!`);
          // No explicit loadWorkspace() call needed here -- the currentUser-keyed effects
          // above pick up the new session and load projects/plans/workspace automatically.
        }}
      />
    );
  }

  // The server refuses everything else until a user who must change their password does so.
  if (currentUser.must_change_password) {
    return (
      <ForcedPasswordChange
        user={currentUser}
        onLogout={handleLogout}
        onChanged={(user) => {
          setCurrentUser(user);
          setUserPermissions(user.permissions || []);
          showToast("Password changed.");
        }}
      />
    );
  }




  // "Expand all"/"Collapse all": only suites with sub-suites have an arrow, so "all expanded"
  // means every one of those is open in the tree as currently shown.
  const expandableSuiteIds = listExpandableSuiteIds(suiteNodes);
  const allSuitesExpanded = expandableSuiteIds.every((id) => suiteExpandedMap[id] ?? true);
  // ---- Spec-mode multi-select + drag-and-drop moving ----
  // Visible tree order (collapsed children excluded) -- what a Shift-range spans in the tree.
  const visibleSuiteOrder = listVisibleSuiteOrder(suiteNodes, suiteExpandedMap);
  const suiteInfoById = buildSuiteInfoById(specData?.suites ?? []);

  const clearSpecMultiSelect = () => {
    setSpecSelectedSuiteIds(new Set());
    setSpecSelectedCaseIds(new Set());
  };

  const handleSpecSuiteClick = (suiteId: string, mods?: { shift: boolean; toggle: boolean }) => {
    if (mods?.shift || mods?.toggle) {
      setSpecSelectedCaseIds(new Set());
      const base = specSelectedSuiteIds.size > 0 ? specSelectedSuiteIds : new Set(selectedSuiteId ? [selectedSuiteId] : []);
      if (mods.shift) {
        const from = suiteSelectAnchorRef.current ?? selectedSuiteId ?? suiteId;
        setSpecSelectedSuiteIds(new Set(rangeBetween(visibleSuiteOrder, from, suiteId)));
      } else {
        const next = new Set(base);
        if (next.has(suiteId)) next.delete(suiteId);
        else next.add(suiteId);
        setSpecSelectedSuiteIds(next);
        suiteSelectAnchorRef.current = suiteId;
      }
      return;
    }
    // Plain click: unchanged behavior (select, Pane 3 shows the suite), selection = this row.
    setSelectedSuiteId(suiteId);
    setSpecSelectedCaseId(null);
    setSpecSelectedSuiteIds(new Set([suiteId]));
    setSpecSelectedCaseIds(new Set());
    suiteSelectAnchorRef.current = suiteId;
  };

  const handleSpecCaseClick = (caseId: string, mods?: { shift: boolean; toggle: boolean }) => {
    if (mods?.shift || mods?.toggle) {
      setSpecSelectedSuiteIds(new Set());
      const order = specCasesForSuite.map((c) => c.id);
      const base = specSelectedCaseIds.size > 0 ? specSelectedCaseIds : new Set(specSelectedCaseId ? [specSelectedCaseId] : []);
      if (mods.shift) {
        const from = caseSelectAnchorRef.current ?? specSelectedCaseId ?? caseId;
        setSpecSelectedCaseIds(new Set(rangeBetween(order, from, caseId)));
      } else {
        const next = new Set(base);
        if (next.has(caseId)) next.delete(caseId);
        else next.add(caseId);
        setSpecSelectedCaseIds(next);
        caseSelectAnchorRef.current = caseId;
      }
      return;
    }
    setSpecSelectedCaseId(caseId);
    setSpecSelectedCaseIds(new Set([caseId]));
    setSpecSelectedSuiteIds(new Set());
    caseSelectAnchorRef.current = caseId;
  };

  // Dragging a selected row drags the whole selection of that kind; otherwise just that row.
  const handleSpecDragStart = (kind: "SUITES" | "CASES", id: string, e: React.DragEvent) => {
    const selection = kind === "SUITES" ? specSelectedSuiteIds : specSelectedCaseIds;
    const ids = selection.has(id) ? [...selection] : [id];
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("application/x-testify-move", JSON.stringify({ kind, ids }));
    // Deferred: changing the DOM inside dragstart (the tree adds its "top level" zone) can
    // make the browser cancel the drag.
    setTimeout(() => setDragPayload({ kind, ids }), 0);
  };

  const canDropSpecItemsOn = (targetSuiteId: string | null): boolean => {
    if (!dragPayload) return false;
    if (dragPayload.kind === "CASES") return targetSuiteId !== null;
    if (targetSuiteId === null) return true;
    const targetPath = suiteInfoById.get(targetSuiteId)?.path ?? "";
    // A suite can't go into itself or one of its own sub-suites.
    return !dragPayload.ids.some((id) => {
      const path = suiteInfoById.get(id)?.path;
      return id === targetSuiteId || (path ? targetPath.startsWith(`${path}/`) : false);
    });
  };

  const handleSpecDrop = async (targetSuiteId: string | null) => {
    const payload = dragPayload;
    setDragPayload(null);
    if (!payload || !selectedProjectId) return;
    try {
      const res = await fetch(`/api/v1/projects/${selectedProjectId}/spec-move`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          ...(payload.kind === "SUITES" ? { suite_ids: payload.ids } : { case_ids: payload.ids }),
          target_suite_id: targetSuiteId,
        }),
      });
      const data = await res.json().catch(() => ({}) as any);
      if (!res.ok) {
        if (res.status === 401) {
          handleAuthExpiry();
          return;
        }
        throw new Error(data.error || data.detail || "Failed to move");
      }
      const moved = (data.moved_suite_count ?? 0) + (data.moved_case_count ?? 0);
      const noun =
        payload.kind === "SUITES"
          ? `${data.moved_suite_count} suite${data.moved_suite_count === 1 ? "" : "s"}`
          : `${data.moved_case_count} case${data.moved_case_count === 1 ? "" : "s"}`;
      const where = targetSuiteId ? suiteInfoById.get(targetSuiteId)?.name ?? "the suite" : "the top level";
      showToast(moved > 0 ? `Moved ${noun} to ${where}` : `Already in ${where}`);
      clearSpecMultiSelect();
      await refreshSpecTree();
    } catch (err: any) {
      showToast(err.message || "Failed to move");
    }
  };

  const toggleAllSuitesExpanded = () => {
    const next = !allSuitesExpanded;
    setSuiteExpandedMap((prev) => {
      const updated = { ...prev };
      for (const id of expandableSuiteIds) updated[id] = next;
      return updated;
    });
  };

  // Backs Pane 3's Suite Details view below -- selectedSuiteId only carries an id, so the
  // full node (name, case counts) has to be looked up from the nested tree each render.
  const specActiveSuite =
    workspaceMode === "SPECIFICATION" && selectedSuiteId && specData
      ? findSuiteNode(specData.suites, selectedSuiteId)
      : null;


  const specActiveCase = specData?.cases.find((c) => c.id === specSelectedCaseId) || null;
  const specVersionDetail = specCaseDetail?.version || null;

  const appContextValue: AppContextValue = {
    currentUser,
    handleLogout,
    handleAuthExpiry,
    showToast,
    can,
    scope,
  };

  return (
    <AppProvider value={appContextValue}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100vh",
          width: "100vw",
          overflow: "hidden",
          backgroundColor: "#090d16",
        }}
      >
        {/* AUTH, ADMIN, & ENTITY MODALS */}
        <AuthModal
          isOpen={authModalOpen}
          onClose={() => setAuthModalOpen(false)}
          currentUser={currentUser}
          onLoginSuccess={(user) => {
            setCurrentUser(user);
            setUserPermissions(user.permissions || []);
            showToast(
              `Welcome back, ${user.username}! Signed in as ${user.global_role}.`,
            );
          }}
          onUpdateCredentialsSuccess={(updatedUser) => {
            setCurrentUser(updatedUser);
          }}
        />

        <AdminPanelModal
          isOpen={adminPanelOpen}
          onClose={() => setAdminPanelOpen(false)}
          currentUser={currentUser}
          projects={projectsList}
          onSelfPermissionsChanged={fetchCurrentUser}
          onCustomFieldsChanged={() => setCustomFieldDefsVersion((v) => v + 1)}
        />

        <ImportWizardModal
          isOpen={importWizardOpen}
          onClose={() => setImportWizardOpen(false)}
          projects={projectsList}
          defaultProjectId={selectedProjectId}
          onImportComplete={refreshSpecTree}
        />

        <ExportModal
          isOpen={exportModalOpen}
          onClose={() => setExportModalOpen(false)}
          projects={projectsList}
          defaultProjectId={selectedProjectId}
        />

        <EntityManagementModal
          isOpen={entityModalOpen}
          onClose={() => setEntityModalOpen(false)}
          entityType={modalEntityType}
          actionType={modalActionType}
          selectedItem={modalSelectedItem}
          onSave={handleSaveEntity}
        />

        {/* TOAST NOTIFICATION OVERLAY */}
        {toastMessage && (
          <div
            style={{
              position: "fixed",
              bottom: "20px",
              right: "20px",
              zIndex: 9999,
              backgroundColor: "#1e293b",
              color: "#f87171",
              border: "1px solid #ef4444",
              padding: "8px 16px",
              borderRadius: "6px",
              boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
              fontSize: "12px",
              fontWeight: 600,
            }}
          >
            {toastMessage}
          </div>
        )}

        <AppHeader
          appView={appView}
          setAppView={setAppView}
          setImportWizardOpen={setImportWizardOpen}
          setExportModalOpen={setExportModalOpen}
          setAdminPanelOpen={setAdminPanelOpen}
          setAuthModalOpen={setAuthModalOpen}
        />

        <StatusBanners
          removeFromPlanPrompt={removeFromPlanPrompt}
          setRemoveFromPlanPrompt={setRemoveFromPlanPrompt}
          handleToggleCaseInclusion={handleToggleCaseInclusion}
          handleToggleSuiteInclusion={handleToggleSuiteInclusion}
          isRunMissing={isRunMissing}
          executionDenied={executionDenied}
          setExecutionDenied={setExecutionDenied}
        />

        {appView === "REPORTS" && hasSpecViewPermission ? (
          <ReportsView
            projectId={selectedProjectId}
            projectName={projectsList.find((p) => p.id === selectedProjectId)?.name ?? ""}
            planId={selectedPlanId}
            runId={selectedRunId}
            runs={runsList}
            plans={plansList}
            canEmail={hasReportEmailPermission}
            onSelectPlan={setSelectedPlanId}
            onOpenInSpec={(caseId) => {
              setAppView("WORKSPACE");
              setWorkspaceMode("SPECIFICATION");
              setSpecSelectedCaseId(caseId);
            }}
            initialLink={INITIAL_REPORTS_LINK}
          />
        ) : (
        /* 3-PANE TOPOLOGY WORKSPACE */
        <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
          {/* PANE 1: RECURSIVE TREE NAVIGATION (28px NODE DENSITY) */}
          <div
            style={{
              width: `${suiteTreeWidth}px`,
              backgroundColor: "#0d111c",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{
                padding: "10px 12px",
                borderBottom: "1px solid #1f2937",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: 600,
                  color: "#6b7280",
                  textTransform: "uppercase",
                }}
              >
                SUITE TREE
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                {workspaceMode === "SPECIFICATION" && hasSpecCreatePermission && (
                  <button
                    onClick={() => openCreateSuiteForm(null)}
                    title="Create a new top-level suite"
                    style={{
                      border: "1px solid #334155",
                      borderRadius: "4px",
                      padding: "2px 8px",
                      fontSize: "11px",
                      fontWeight: 700,
                      cursor: "pointer",
                      backgroundColor: "transparent",
                      color: "#60a5fa",
                    }}
                  >
                    + Suite
                  </button>
                )}
                {/* SPECIFICATION / EXECUTION MODE TOGGLE -- visible to any authenticated user
                    (per-case/suite plan-inclusion buttons are the part gated by PLAN_MANAGE,
                    not this toggle itself). */}
                <div
                  style={{
                    display: "flex",
                    border: "1px solid #334155",
                    borderRadius: "4px",
                    overflow: "hidden",
                  }}
                >
                  {(["EXECUTION", "SPECIFICATION"] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => setWorkspaceMode(m)}
                      disabled={m === "SPECIFICATION" && !hasSpecViewPermission}
                      title={m === "SPECIFICATION" && !hasSpecViewPermission ? "Your role can't view test specifications" : undefined}
                      style={{
                        border: "none",
                        padding: "3px 8px",
                        fontSize: "10px",
                        fontWeight: 700,
                        cursor: m === "SPECIFICATION" && !hasSpecViewPermission ? "not-allowed" : "pointer",
                        opacity: m === "SPECIFICATION" && !hasSpecViewPermission ? 0.4 : 1,
                        backgroundColor: workspaceMode === m ? "#3b82f6" : "#1e293b",
                        color: workspaceMode === m ? "#ffffff" : "#9ca3af",
                      }}
                    >
                      {m === "EXECUTION" ? "Execute" : "Spec"}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <CaseFilterPanel
              value={caseFilter}
              onChange={setCaseFilter}
              fields={caseFilterFields}
              mode={workspaceMode}
              hasPlan={Boolean(selectedPlanId)}
              hasRun={Boolean(selectedRunId)}
              searchInputRef={searchInputRef}
              matchCount={
                filterResult
                  ? workspaceMode === "EXECUTION"
                    ? visibleCaseIndices.length
                    : filterResult.caseIds.size
                  : null
              }
              totalCount={
                workspaceMode === "EXECUTION" ? workspace?.cases.length || 0 : specData?.cases.length || 0
              }
              onRequestFields={loadCaseFilterFields}
              showDeprecated={showDeprecated}
              onToggleShowDeprecated={() => setShowDeprecated((v) => !v)}
              treeExpandControl={
                expandableSuiteIds.length > 0
                  ? { allExpanded: allSuitesExpanded, onToggle: toggleAllSuitesExpanded }
                  : undefined
              }
              runControl={
                workspaceMode === "EXECUTION" && selectedRun
                  ? {
                      closed: selectedRun.status === "CLOSED",
                      canToggle: hasRunManagePermission,
                      pending: isTogglingRun,
                      onToggle: handleToggleRunClosed,
                    }
                  : undefined
              }
            />
            {filterError && (
              <div style={{ padding: "4px 12px", fontSize: "10px", color: "#f87171", borderBottom: "1px solid #1f2937" }}>
                {filterError}
              </div>
            )}

            {workspaceMode === "SPECIFICATION" && suiteFormState && (
              <div
                style={{
                  padding: "10px 12px",
                  borderBottom: "1px solid #1f2937",
                  backgroundColor: "#111827",
                }}
              >
                <div style={{ fontSize: "11px", fontWeight: 600, color: "#e5e7eb", marginBottom: "6px" }}>
                  {suiteFormState.mode === "CREATE" ? "New Suite" : "Rename / Move Suite"}
                </div>
                <input
                  type="text"
                  placeholder="Suite name"
                  value={suiteFormState.name}
                  onChange={(e) => setSuiteFormState((prev) => (prev ? { ...prev, name: e.target.value } : prev))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && suiteFormState.name.trim() && !isSavingSuiteForm) handleSaveSuiteForm();
                  }}
                  autoFocus
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    padding: "5px 8px",
                    marginBottom: "6px",
                    backgroundColor: "#0d111c",
                    border: "1px solid #1f2937",
                    borderRadius: "4px",
                    color: "#f8fafc",
                    fontSize: "12px",
                  }}
                />
                <select
                  value={suiteFormState.parentSuiteId ?? ""}
                  onChange={(e) =>
                    setSuiteFormState((prev) => (prev ? { ...prev, parentSuiteId: e.target.value || null } : prev))
                  }
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    padding: "5px 8px",
                    marginBottom: "6px",
                    backgroundColor: "#0d111c",
                    border: "1px solid #1f2937",
                    borderRadius: "4px",
                    color: "#f8fafc",
                    fontSize: "12px",
                  }}
                >
                  <option value="">(Top-level, no parent)</option>
                  {flattenSuiteOptions(suiteNodes).map((o) => (
                    <option key={o.id} value={o.id} disabled={o.id === suiteFormState.targetId}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <div style={{ display: "flex", gap: "6px" }}>
                  <button
                    onClick={() => setSuiteFormState(null)}
                    style={{
                      flex: 1,
                      padding: "5px",
                      backgroundColor: "#334155",
                      border: "none",
                      borderRadius: "4px",
                      color: "#fff",
                      fontSize: "11px",
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSaveSuiteForm}
                    disabled={isSavingSuiteForm || !suiteFormState.name.trim()}
                    style={{
                      flex: 1,
                      padding: "5px",
                      backgroundColor: isSavingSuiteForm ? "#166534" : "#16a34a",
                      border: "none",
                      borderRadius: "4px",
                      color: "#fff",
                      fontSize: "11px",
                      fontWeight: 600,
                      cursor: isSavingSuiteForm ? "default" : "pointer",
                    }}
                  >
                    {isSavingSuiteForm ? "Saving..." : "Save"}
                  </button>
                </div>
              </div>
            )}

            {workspaceMode === "SPECIFICATION" && deleteSuitePrompt && (
              <div
                style={{
                  padding: "10px 12px",
                  borderBottom: "1px solid #92400e",
                  backgroundColor: "#78350f",
                }}
              >
                <div style={{ fontSize: "11px", color: "#fbbf24", fontWeight: 600, marginBottom: "6px" }}>
                  ⚠️ Confirm Deletion
                </div>
                <div style={{ fontSize: "11px", color: "#fde68a", marginBottom: "8px", lineHeight: 1.4 }}>
                  {deleteSuitePrompt.detail}
                </div>
                <div style={{ display: "flex", gap: "6px" }}>
                  <button
                    onClick={() => setDeleteSuitePrompt(null)}
                    style={{
                      flex: 1,
                      padding: "5px",
                      backgroundColor: "#334155",
                      border: "none",
                      borderRadius: "4px",
                      color: "#fff",
                      fontSize: "11px",
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleConfirmDeleteSuite}
                    style={{
                      flex: 1,
                      padding: "5px",
                      backgroundColor: "#dc2626",
                      border: "none",
                      borderRadius: "4px",
                      color: "#fff",
                      fontSize: "11px",
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    Delete Anyway
                  </button>
                </div>
              </div>
            )}

            <VirtualizedSuiteTree
              suites={suiteNodes}
              expandedMap={suiteExpandedMap}
              onExpandedMapChange={setSuiteExpandedMap}
              selectedSuiteId={
                workspaceMode === "EXECUTION"
                  ? execSuiteFilterId
                  : specSelectedSuiteIds.size > 0
                    ? null
                    : selectedSuiteId
              }
              selectedSuiteIds={workspaceMode === "SPECIFICATION" ? specSelectedSuiteIds : undefined}
              canDrag={workspaceMode === "SPECIFICATION" && hasSpecEditPermission}
              onDragStartSuite={(id, e) => handleSpecDragStart("SUITES", id, e)}
              onDragEndItems={() => setDragPayload(null)}
              draggingKind={workspaceMode === "SPECIFICATION" ? dragPayload?.kind ?? null : null}
              canDropOn={canDropSpecItemsOn}
              onDropOn={handleSpecDrop}
              activeSuiteId={
                workspaceMode === "EXECUTION" ? activeCase?.test_suite_id || null : null
              }
              onSelectSuite={(suiteId, mods) => {
                if (workspaceMode === "EXECUTION") {
                  // Execute mode: narrows the queue to this suite's cases; clicking the selected
                  // suite again shows everything again. If the active case isn't in the suite,
                  // jump to the suite's first case so the active case is always listed.
                  if (execSuiteFilterId === suiteId) {
                    setExecSuiteFilterId(null);
                    return;
                  }
                  setExecSuiteFilterId(suiteId);
                  const inSuite = visibleCaseIndices.filter(
                    (i) => workspace?.cases[i]?.test_suite_id === suiteId,
                  );
                  if (inSuite.length > 0 && !inSuite.includes(selectedIndex)) setSelectedIndex(inSuite[0]);
                  return;
                }
                // Spec mode: a plain click is deliberately not a toggle -- clicking the already-
                // selected suite again must not deselect it (per direct request); it switches
                // Pane 3 back to that suite's details. Shift/Ctrl-Cmd build a multi-selection.
                handleSpecSuiteClick(suiteId, mods);
              }}
              mode={workspaceMode}
              canManagePlan={hasPlanManagePermission}
              onToggleSuiteInclusion={handleToggleSuiteInclusion}
              canCreateSuites={hasSpecCreatePermission}
              canEditSuites={hasSpecEditPermission}
              canDeleteSuites={hasSpecDeletePermission}
              onCreateChildSuite={(parentId) => openCreateSuiteForm(parentId)}
              onRenameSuite={(suiteId, name, parentId) => openRenameSuiteForm(suiteId, name, parentId)}
              onDeleteSuite={(suiteId) => handleDeleteSuiteClick(suiteId)}
            />
          </div>

          {/* DIVIDER: PANE 1 / PANE 2 */}
          <div
            onMouseDown={handleDividerMouseDown("tree")}
            onMouseEnter={() => setHoveredDivider("tree")}
            onMouseLeave={() => setHoveredDivider(null)}
            style={dividerStyle("tree")}
          />

          {/* PANE 2: TEST CASE QUEUE GRID (32px ROW DENSITY) */}
          <div
            style={{
              width: `${queueGridWidth}px`,
              backgroundColor: "#111827",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{
                padding: "10px 12px",
                borderBottom: "1px solid #1f2937",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: 600,
                  color: "#6b7280",
                  textTransform: "uppercase",
                }}
              >
                {workspaceMode === "SPECIFICATION" ? "SPECIFICATION" : "QUEUE GRID"}
              </span>
              {workspaceMode === "SPECIFICATION" ? (
                <span style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ fontSize: "11px", color: "#9ca3af" }}>
                    {specCasesForSuite.filter((c) => c.in_plan).length}/{specCasesForSuite.length} in plan
                  </span>
                  {hasSpecCreatePermission && (
                    <button
                      onClick={() => setIsCaseCreateFormOpen((prev) => !prev)}
                      disabled={!selectedSuiteId}
                      title={selectedSuiteId ? "Create a new case in the selected suite" : "Select a suite first"}
                      style={{
                        border: "1px solid #334155",
                        borderRadius: "4px",
                        padding: "2px 8px",
                        fontSize: "11px",
                        fontWeight: 700,
                        cursor: selectedSuiteId ? "pointer" : "not-allowed",
                        backgroundColor: "transparent",
                        color: selectedSuiteId ? "#60a5fa" : "#4b5563",
                      }}
                    >
                      + Case
                    </button>
                  )}
                </span>
              ) : (
                <span style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
                {execSuiteFilterId && (
                  <button
                    onClick={() => setExecSuiteFilterId(null)}
                    title="Showing one suite's cases -- click to show all cases again"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "4px",
                      maxWidth: "160px",
                      border: "1px solid #1e3a8a",
                      borderRadius: "4px",
                      padding: "1px 6px",
                      fontSize: "10px",
                      fontWeight: 700,
                      backgroundColor: "rgba(59, 130, 246, 0.12)",
                      color: "#93c5fd",
                      cursor: "pointer",
                    }}
                  >
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      📁 {specData ? findSuiteNode(specData.suites, execSuiteFilterId)?.name ?? "Suite" : "Suite"}
                    </span>
                    <span>✕</span>
                  </button>
                )}
                <span style={{ fontSize: "11px", color: "#9ca3af", whiteSpace: "nowrap" }}>
                  <span style={{ color: "#10b981" }}>{passedCount} Pass</span> |{" "}
                  <span style={{ color: "#ef4444" }}>{failedCount} Fail</span>
                </span>
                </span>
              )}
            </div>

            {workspaceMode === "SPECIFICATION" && isCaseCreateFormOpen && selectedSuiteId && (
              <div style={{ padding: "10px 12px", borderBottom: "1px solid #1f2937", backgroundColor: "#0d111c" }}>
                <input
                  type="text"
                  placeholder="New case title"
                  value={newCaseTitle}
                  onChange={(e) => setNewCaseTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newCaseTitle.trim() && !isCreatingCase) handleCreateCase();
                  }}
                  autoFocus
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    padding: "5px 8px",
                    marginBottom: "6px",
                    backgroundColor: "#111827",
                    border: "1px solid #1f2937",
                    borderRadius: "4px",
                    color: "#f8fafc",
                    fontSize: "12px",
                  }}
                />
                <div style={{ display: "flex", gap: "6px", marginBottom: "6px" }}>
                  <select
                    value={newCasePriority}
                    onChange={(e) => setNewCasePriority(e.target.value)}
                    style={{
                      flex: 1,
                      padding: "5px 8px",
                      backgroundColor: "#111827",
                      border: "1px solid #1f2937",
                      borderRadius: "4px",
                      color: "#f8fafc",
                      fontSize: "12px",
                    }}
                  >
                    {["LOW", "MEDIUM", "HIGH", "CRITICAL"].map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                  <select
                    value={newCaseExecutionType}
                    onChange={(e) => setNewCaseExecutionType(e.target.value)}
                    style={{
                      flex: 1,
                      padding: "5px 8px",
                      backgroundColor: "#111827",
                      border: "1px solid #1f2937",
                      borderRadius: "4px",
                      color: "#f8fafc",
                      fontSize: "12px",
                    }}
                  >
                    {["MANUAL", "AUTOMATED"].map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>
                <div style={{ display: "flex", gap: "6px" }}>
                  <button
                    onClick={() => setIsCaseCreateFormOpen(false)}
                    style={{
                      flex: 1,
                      padding: "5px",
                      backgroundColor: "#334155",
                      border: "none",
                      borderRadius: "4px",
                      color: "#fff",
                      fontSize: "11px",
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleCreateCase}
                    disabled={isCreatingCase || !newCaseTitle.trim()}
                    style={{
                      flex: 1,
                      padding: "5px",
                      backgroundColor: isCreatingCase ? "#166534" : "#16a34a",
                      border: "none",
                      borderRadius: "4px",
                      color: "#fff",
                      fontSize: "11px",
                      fontWeight: 600,
                      cursor: isCreatingCase ? "default" : "pointer",
                    }}
                  >
                    {isCreatingCase ? "Creating..." : "Create Case"}
                  </button>
                </div>
              </div>
            )}

            {(workspaceMode === "SPECIFICATION"
              ? filterResult && specCasesForSuite.length === 0
              : (filterResult || execSuiteFilterId) && queueCaseIndices.length === 0) && (
                <div style={{ padding: "16px 12px", fontSize: "11px", color: "#6b7280", textAlign: "center" }}>
                  {workspaceMode === "SPECIFICATION"
                    ? selectedSuiteId
                      ? "No cases in this suite match the current search/filters."
                      : "No cases match the current search/filters."
                    : execSuiteFilterId
                      ? filterResult
                        ? "No cases in this suite match the current search/filters."
                        : "None of this suite's cases are in this test plan."
                      : "No cases match the current search/filters."}
                </div>
              )}
            {workspaceMode === "SPECIFICATION" ? (
              <SpecCaseListGrid
                cases={specCasesForSuite}
                selectedCaseId={specSelectedCaseIds.size > 0 ? null : specSelectedCaseId}
                selectedCaseIds={specSelectedCaseIds}
                onSelectCase={handleSpecCaseClick}
                canDrag={hasSpecEditPermission}
                onDragStartCase={(id, e) => handleSpecDragStart("CASES", id, e)}
                onDragEndItems={() => setDragPayload(null)}
                canManagePlan={hasPlanManagePermission}
                onToggleInclusion={handleToggleCaseInclusion}
                pendingCaseId={pendingToggleId}
              />
            ) : (
              <TestCaseQueueGrid
                cases={
                  filterResult || execSuiteFilterId
                    ? queueCaseIndices.map((i) => workspace.cases[i])
                    : workspace.cases
                }
                selectedIndex={selectedVisiblePos}
                onSelectCase={(pos) => {
                  const target = queueCaseIndices[pos];
                  if (target !== undefined) setSelectedIndex(target);
                }}
              />
            )}
          </div>

          {/* DIVIDER: PANE 2 / PANE 3 */}
          <div
            onMouseDown={handleDividerMouseDown("queue")}
            onMouseEnter={() => setHoveredDivider("queue")}
            onMouseLeave={() => setHoveredDivider(null)}
            style={dividerStyle("queue")}
          />

          {/* PANE 3: EXECUTION & DETAIL WORKSPACE (FLUID) */}
          <div
            style={{
              flex: 1,
              backgroundColor: "#0d111c",
              display: "flex",
              flexDirection: "column",
            }}
          >
            {workspaceMode === "SPECIFICATION" ? (
              specActiveCase ? (
                <>
                  {/* SPEC CASE HEADER + PLAN-INCLUSION TOGGLE */}
                  <div
                    style={{
                      padding: "16px 20px",
                      borderBottom: "1px solid #1f2937",
                      display: "flex",
                      alignItems: "flex-start",
                      justifyContent: "space-between",
                    }}
                  >
                    {/* Row 1: id + title, the title stretching all the way to the action
                        buttons. Row 2 (always its own line): priority, execution type, version
                        badge, Approve. */}
                    <div
                      style={{
                        flex: 1,
                        minWidth: 0,
                        marginRight: "12px",
                        display: "flex",
                        flexDirection: "column",
                        gap: "8px",
                      }}
                    >
                    <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                      <span style={{ fontSize: "16px", fontWeight: 700, color: "#f9fafb", flexShrink: 0 }}>
                        {specActiveCase.external_id}
                      </span>
                      <input
                        key={specActiveCase.id}
                        type="text"
                        defaultValue={specActiveCase.title}
                        onBlur={(e) => {
                          const input = e.target;
                          if (input.value !== specActiveCase.title) {
                            // A refused save (e.g. a blank title) puts the saved title back, so
                            // the box never shows a title the case doesn't have.
                            const saved = specActiveCase.title;
                            handleUpdateCaseField("title", input.value).then((ok) => {
                              if (!ok) input.value = saved;
                            });
                          }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") e.currentTarget.blur();
                        }}
                        disabled={!hasSpecEditPermission}
                        title={hasSpecEditPermission ? "Case title" : "Requires SPEC_EDIT permission"}
                        style={{
                          fontSize: "14px",
                          color: "#f8fafc",
                          backgroundColor: hasSpecEditPermission ? "#111827" : "transparent",
                          border: hasSpecEditPermission ? "1px solid #1f2937" : "none",
                          borderRadius: "4px",
                          padding: hasSpecEditPermission ? "3px 8px" : "0",
                          flex: 1,
                          minWidth: 0,
                          opacity: hasSpecEditPermission ? 1 : 0.85,
                        }}
                      />
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                      <select
                        value={specActiveCase.priority}
                        onChange={(e) => handleUpdateCaseField("priority", e.target.value)}
                        disabled={!hasSpecEditPermission}
                        style={{
                          fontSize: "11px",
                          backgroundColor: "#111827",
                          border: "1px solid #1f2937",
                          borderRadius: "4px",
                          color: "#f8fafc",
                          padding: "3px 6px",
                          opacity: hasSpecEditPermission ? 1 : 0.6,
                        }}
                      >
                        {["LOW", "MEDIUM", "HIGH", "CRITICAL"].map((p) => (
                          <option key={p} value={p}>
                            {p}
                          </option>
                        ))}
                      </select>
                      <select
                        value={specActiveCase.execution_type ?? "MANUAL"}
                        onChange={(e) => handleUpdateCaseField("execution_type", e.target.value)}
                        disabled={!hasSpecEditPermission}
                        style={{
                          fontSize: "11px",
                          backgroundColor: "#111827",
                          border: "1px solid #1f2937",
                          borderRadius: "4px",
                          color: "#f8fafc",
                          padding: "3px 6px",
                          opacity: hasSpecEditPermission ? 1 : 0.6,
                        }}
                      >
                        {["MANUAL", "AUTOMATED"].map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                      {specActiveCase.latest_version && (
                        <span
                          style={{
                            fontSize: "11px",
                            padding: "2px 8px",
                            borderRadius: "4px",
                            backgroundColor:
                              specActiveCase.latest_version.status === "APPROVED"
                                ? "#064e3b"
                                : "#1f2937",
                            color:
                              specActiveCase.latest_version.status === "APPROVED"
                                ? "#34d399"
                                : "#9ca3af",
                            fontWeight: 600,
                          }}
                        >
                          v{specActiveCase.latest_version.version_number}{" "}
                          {specActiveCase.latest_version.status}
                        </span>
                      )}
                      {specActiveCase.latest_version?.status === "DRAFT" && hasSpecApprovePermission && (
                        <button
                          onClick={handleApproveVersion}
                          disabled={isApprovingVersion}
                          style={{
                            fontSize: "11px",
                            padding: "3px 8px",
                            borderRadius: "4px",
                            border: "1px solid #22c55e",
                            backgroundColor: "rgba(34, 197, 94, 0.12)",
                            color: "#4ade80",
                            fontWeight: 700,
                            cursor: isApprovingVersion ? "default" : "pointer",
                          }}
                        >
                          {isApprovingVersion ? "Approving…" : "✓ Approve"}
                        </button>
                      )}
                      {/* The rest of the lifecycle button: Approved -> Deprecate (muted red
                          outline, so it doesn't read as a primary action), Deprecated -> Restore. */}
                      {(specActiveCase.latest_version?.status === "APPROVED" ||
                        specActiveCase.latest_version?.status === "DEPRECATED") &&
                        hasSpecApprovePermission &&
                        (() => {
                          const isDeprecated = specActiveCase.latest_version?.status === "DEPRECATED";
                          return (
                            <button
                              onClick={() => handleVersionTransition(isDeprecated ? "restore" : "deprecate")}
                              disabled={isTransitioningVersion}
                              title={
                                isDeprecated
                                  ? "Restore this test case to Approved"
                                  : "Retire this test case: it's hidden from the Spec list and can't be added to plans"
                              }
                              style={{
                                fontSize: "11px",
                                padding: "3px 8px",
                                borderRadius: "4px",
                                border: isDeprecated ? "1px solid #6b7280" : "1px solid #7f1d1d",
                                backgroundColor: "transparent",
                                color: isDeprecated ? "#d1d5db" : "#f87171",
                                fontWeight: 700,
                                cursor: isTransitioningVersion ? "default" : "pointer",
                              }}
                            >
                              {isTransitioningVersion ? "…" : isDeprecated ? "↺ Restore" : "Deprecate"}
                            </button>
                          );
                        })()}
                    </div>
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
                      {/* The plan-inclusion toggle used to live here ("+ Add to Plan"/"✓ In Plan"),
                          but every case already has the identical toggle on its own row in the
                          case list (SpecCaseListGrid's onToggleInclusion/pendingCaseId -- same
                          handleToggleCaseInclusion/pendingToggleId state) -- removed as a
                          duplicate, per direct request, and replaced with the Edit action moved
                          here from up by the version badge, so it sits next to Delete instead. */}
                      {specActiveCase.latest_version?.status === "APPROVED" && hasSpecEditPermission && (
                        <button
                          onClick={handleCreateDraft}
                          disabled={isCreatingDraft}
                          title="Create a new draft to edit this case"
                          style={{
                            flexShrink: 0,
                            padding: "6px 14px",
                            borderRadius: "4px",
                            fontSize: "12px",
                            fontWeight: 700,
                            border: "1px solid #f59e0b",
                            backgroundColor: "rgba(245, 158, 11, 0.12)",
                            color: "#fbbf24",
                            cursor: isCreatingDraft ? "default" : "pointer",
                          }}
                        >
                          {isCreatingDraft ? "Creating…" : "Edit"}
                        </button>
                      )}
                      {hasSpecDeletePermission && (
                        <button
                          onClick={() => handleDeleteCaseClick(specActiveCase.id)}
                          title="Delete case"
                          style={{
                            flexShrink: 0,
                            padding: "6px 10px",
                            borderRadius: "4px",
                            fontSize: "12px",
                            border: "1px solid #4b5563",
                            backgroundColor: "transparent",
                            color: "#f87171",
                            cursor: "pointer",
                          }}
                        >
                          🗑️
                        </button>
                      )}
                    </div>
                  </div>

                  {deleteCasePrompt && deleteCasePrompt.id === specActiveCase.id && (
                    <div style={{ padding: "12px 20px", borderBottom: "1px solid #92400e", backgroundColor: "#78350f" }}>
                      <div style={{ fontSize: "12px", color: "#fbbf24", fontWeight: 600, marginBottom: "6px" }}>
                        ⚠️ Confirm Deletion
                      </div>
                      <div style={{ fontSize: "12px", color: "#fde68a", marginBottom: "10px", lineHeight: 1.4 }}>
                        {deleteCasePrompt.detail}
                      </div>
                      <div style={{ display: "flex", gap: "8px" }}>
                        <button
                          onClick={() => setDeleteCasePrompt(null)}
                          style={{ padding: "6px 14px", backgroundColor: "#334155", border: "none", borderRadius: "4px", color: "#fff", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}
                        >
                          Cancel
                        </button>
                        <button
                          onClick={handleConfirmDeleteCase}
                          style={{ padding: "6px 14px", backgroundColor: "#dc2626", border: "none", borderRadius: "4px", color: "#fff", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}
                        >
                          Delete Anyway
                        </button>
                      </div>
                    </div>
                  )}

                  {specEditError && (
                    <div style={{ padding: "8px 20px", fontSize: "12px", color: "#f87171", backgroundColor: "#111827", borderBottom: "1px solid #1f2937" }}>
                      ⚠️ {specEditError}
                    </div>
                  )}

                  {/* CASE DETAILS -- title/priority/execution_type (above) are always
                      editable; preconditions/summary/steps/custom fields below are editable
                      only while the latest version is DRAFT ("Edit" above unlocks this for
                      an APPROVED case by creating a new draft). Custom field *values* aren't
                      version-locked server-side (setValue works against any status, by
                      design -- see CLAUDE.md), but the UI still only offers editing them in
                      lockstep with everything else in this pane, matching how a locked case
                      reads as fully read-only rather than partially editable. */}
                  <div ref={specDetailScrollRef} style={{ flex: 1, padding: "20px", overflowY: "auto" }}>
                    {(() => {
                      const isDraft = specVersionDetail?.status === "DRAFT";
                      return (
                        <>
                          {(isDraft || specVersionDetail?.summary) && (
                            <div
                              style={{
                                marginBottom: "16px",
                                backgroundColor: "#111827",
                                padding: "12px",
                                borderRadius: "6px",
                                border: "1px solid #1f2937",
                              }}
                            >
                              <div
                                style={{
                                  fontSize: "11px",
                                  fontWeight: 600,
                                  color: "#6b7280",
                                  textTransform: "uppercase",
                                  marginBottom: "4px",
                                }}
                              >
                                Summary
                              </div>
                              {isDraft && hasSpecEditPermission ? (
                                <textarea
                                  key={`sum-${specVersionDetail?.id}`}
                                  ref={autoGrowTextarea}
                                  defaultValue={specVersionDetail?.summary ?? ""}
                                  onInput={(e) => autoGrowTextarea(e.currentTarget)}
                                  onBlur={(e) => handleSaveVersionContent("summary", e.target.value)}
                                  rows={2}
                                  style={{
                                    width: "100%",
                                    boxSizing: "border-box",
                                    fontSize: "12px",
                                    color: "#f8fafc",
                                    backgroundColor: "#0d111c",
                                    border: "1px solid #1f2937",
                                    borderRadius: "4px",
                                    padding: "6px 8px",
                                    resize: "none",
                                    overflow: "hidden",
                                  }}
                                />
                              ) : (
                                <div style={{ fontSize: "12px", color: "#d1d5db" }}>
                                  {specVersionDetail?.summary}
                                </div>
                              )}
                            </div>
                          )}

                          <div
                            style={{
                              marginBottom: "16px",
                              backgroundColor: "#111827",
                              padding: "12px",
                              borderRadius: "6px",
                              border: "1px solid #1f2937",
                            }}
                          >
                            <div
                              style={{
                                fontSize: "11px",
                                fontWeight: 600,
                                color: "#6b7280",
                                textTransform: "uppercase",
                                marginBottom: "4px",
                              }}
                            >
                              Preconditions
                            </div>
                            {isDraft && hasSpecEditPermission ? (
                              <textarea
                                key={`pre-${specVersionDetail?.id}`}
                                ref={autoGrowTextarea}
                                defaultValue={specVersionDetail?.preconditions ?? ""}
                                onInput={(e) => autoGrowTextarea(e.currentTarget)}
                                onBlur={(e) => handleSaveVersionContent("preconditions", e.target.value)}
                                rows={2}
                                style={{
                                  width: "100%",
                                  boxSizing: "border-box",
                                  fontSize: "12px",
                                  color: "#f8fafc",
                                  backgroundColor: "#0d111c",
                                  border: "1px solid #1f2937",
                                  borderRadius: "4px",
                                  padding: "6px 8px",
                                  resize: "none",
                                  overflow: "hidden",
                                }}
                              />
                            ) : (
                              <div style={{ fontSize: "12px", color: "#d1d5db" }}>
                                {specVersionDetail?.preconditions || "—"}
                              </div>
                            )}
                          </div>

                          <div
                            style={{
                              fontSize: "11px",
                              fontWeight: 600,
                              color: "#6b7280",
                              textTransform: "uppercase",
                              marginBottom: "8px",
                            }}
                          >
                            Ordered Step Specification {isDraft ? "" : "(read-only)"}
                          </div>

                          {isDraft && hasSpecEditPermission ? (
                            <div>
                              {stepsDraft.map((step, i) => (
                                <div
                                  key={step.id}
                                  style={{
                                    display: "flex",
                                    gap: "6px",
                                    alignItems: "flex-start",
                                    marginBottom: "6px",
                                    backgroundColor: "#0d111c",
                                    border: "1px solid #1f2937",
                                    borderRadius: "4px",
                                    padding: "6px",
                                  }}
                                >
                                  <span style={{ fontSize: "11px", color: "#6b7280", padding: "6px 2px" }}>
                                    {i + 1}
                                  </span>
                                  <textarea
                                    ref={(el) => {
                                      stepActionRefs.current[i] = el;
                                      // Only auto-size on genuine mount (no inline height set yet), not on
                                      // every reattach -- this callback closes over `i`, so it's a fresh
                                      // function identity every render, and React detaches/reattaches it
                                      // for EVERY row (not just a changed one) on every commit that
                                      // touches this list. Calling autoGrowTextarea unconditionally here
                                      // meant every existing row got a synchronous forced-reflow resize on
                                      // every add/move/remove -- extra layout thrash interleaved with
                                      // exactly the commits the scroll-jump fixes above care about. Live
                                      // growth while typing is already covered by onInput below.
                                      if (el && !el.style.height) autoGrowTextarea(el);
                                    }}
                                    placeholder="Action"
                                    value={step.action}
                                    onChange={(e) => updateStepField(i, { action: e.target.value })}
                                    onInput={(e) => autoGrowTextarea(e.currentTarget)}
                                    onBlur={() => { stepsScroll.captureScroll(); saveSteps(); }}
                                    rows={1}
                                    style={{
                                      flex: 1,
                                      fontSize: "12px",
                                      color: "#f8fafc",
                                      backgroundColor: "#111827",
                                      border: "1px solid #1f2937",
                                      borderRadius: "4px",
                                      padding: "5px 8px",
                                      resize: "none",
                                      overflow: "hidden",
                                    }}
                                  />
                                  <textarea
                                    ref={autoGrowTextarea}
                                    placeholder="Expected Result"
                                    value={step.expected_result}
                                    onChange={(e) => updateStepField(i, { expected_result: e.target.value })}
                                    onInput={(e) => autoGrowTextarea(e.currentTarget)}
                                    onBlur={() => { stepsScroll.captureScroll(); saveSteps(); }}
                                    rows={1}
                                    style={{
                                      flex: 1,
                                      fontSize: "12px",
                                      color: "#a7f3d0",
                                      backgroundColor: "#111827",
                                      border: "1px solid #1f2937",
                                      borderRadius: "4px",
                                      padding: "5px 8px",
                                      resize: "none",
                                      overflow: "hidden",
                                    }}
                                  />
                                  <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                    <button
                                      onClick={() => moveStep(i, -1)}
                                      disabled={i === 0}
                                      title="Move up"
                                      style={{ background: "none", border: "none", color: i === 0 ? "#4b5563" : "#9ca3af", cursor: i === 0 ? "not-allowed" : "pointer", fontSize: "10px" }}
                                    >
                                      ▲
                                    </button>
                                    <button
                                      onClick={() => moveStep(i, 1)}
                                      disabled={i === stepsDraft.length - 1}
                                      title="Move down"
                                      style={{ background: "none", border: "none", color: i === stepsDraft.length - 1 ? "#4b5563" : "#9ca3af", cursor: i === stepsDraft.length - 1 ? "not-allowed" : "pointer", fontSize: "10px" }}
                                    >
                                      ▼
                                    </button>
                                  </div>
                                  <button
                                    onClick={() => removeStep(i)}
                                    title="Remove step"
                                    style={{ background: "none", border: "none", color: "#f87171", cursor: "pointer", fontSize: "12px", padding: "6px 2px" }}
                                  >
                                    🗑️
                                  </button>
                                </div>
                              ))}
                              <button
                                onClick={addStep}
                                style={{
                                  padding: "4px 10px",
                                  backgroundColor: "transparent",
                                  border: "1px dashed #475569",
                                  borderRadius: "4px",
                                  color: "#94a3b8",
                                  fontSize: "11px",
                                  cursor: "pointer",
                                }}
                              >
                                + Add Step
                              </button>
                              <div ref={stepsEndAnchorRef} />
                              {/* Always mounted (not conditionally rendered) so toggling it never changes
                                  specDetailScrollRef's scrollHeight -- a conditionally-mounted version
                                  growing/shrinking the container on every autosave was the primary cause
                                  of the focus-swap/blur jitter: shrinking scrollHeight when a save
                                  resolves makes the browser synchronously clamp scrollTop down, a visible
                                  jump with no coordination from any of our own scroll-preservation code. */}
                              <div
                                aria-hidden={!isSavingSteps}
                                style={{
                                  marginTop: "10px",
                                  textAlign: "right",
                                  fontSize: "11px",
                                  color: "#6b7280",
                                  opacity: isSavingSteps ? 1 : 0,
                                  visibility: isSavingSteps ? "visible" : "hidden",
                                }}
                              >
                                Saving…
                              </div>
                            </div>
                          ) : (
                            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                              <thead>
                                <tr
                                  style={{
                                    borderBottom: "1px solid #1f2937",
                                    color: "#9ca3af",
                                    textAlign: "left",
                                  }}
                                >
                                  <th style={{ padding: "6px", width: "50px" }}>#</th>
                                  <th style={{ padding: "6px" }}>Action</th>
                                  <th style={{ padding: "6px" }}>Expected Result</th>
                                </tr>
                              </thead>
                              <tbody>
                                {(specVersionDetail?.steps || []).map((step) => (
                                  <tr
                                    key={step.id}
                                    style={{ borderBottom: "1px solid #1f2937", color: "#d1d5db" }}
                                  >
                                    <td style={{ padding: "8px 6px", fontWeight: 600 }}>
                                      {step.step_number}
                                    </td>
                                    <td style={{ padding: "8px 6px" }}>{step.action}</td>
                                    <td style={{ padding: "8px 6px", color: "#a7f3d0" }}>
                                      {step.expected_result}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                          {!specVersionDetail && (
                            <div style={{ marginTop: "12px", color: "#6b7280", fontSize: "12px" }}>
                              Loading step detail…
                            </div>
                          )}

                          {specCaseCustomFieldValues && specCaseCustomFieldValues.length > 0 && (
                            <div style={{ marginTop: "16px" }}>
                              {specCaseCustomFieldValues.map((entry) => (
                                <CustomFieldEditor
                                  key={`${specSelectedCaseId}-${entry.definition.id}-${customFieldResetKeyById[entry.definition.id] ?? 0}`}
                                  entry={entry}
                                  onChange={(value) => handleCustomFieldValueChange(entry.definition.id, value)}
                                  disabled={!(isDraft && hasPlanManagePermission)}
                                  disabledTitle={
                                    !isDraft
                                      ? specVersionDetail?.status === "DEPRECATED"
                                        ? "This test case is deprecated -- restore it to edit"
                                        : "Editable only while in Draft -- click Edit to create a new draft"
                                      : "Requires plan management permission"
                                  }
                                  errorMessage={customFieldErrorById[entry.definition.id] ?? null}
                                  isSaving={savingCustomFieldId === entry.definition.id}
                                />
                              ))}
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </div>
                </>
              ) : specActiveSuite ? (
                <>
                  {/* SUITE DETAILS -- name + custom fields. Replaces the case detail view
                      whenever a suite (not a case) is the current selection; clicking a case
                      in the list takes priority again (specActiveCase above), matching how
                      onSelectSuite/onSelectCase never clear each other's underlying id, only
                      which one this view prefers to show. This is now the only place a
                      suite's custom field values are shown/edited -- the tree's old "✎ Fields"
                      button (which opened a separate floating panel) was removed as redundant. */}
                  <div
                    style={{
                      padding: "16px 20px",
                      borderBottom: "1px solid #1f2937",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px" }}>
                      <span style={{ fontSize: "16px" }}>📁</span>
                      <input
                        key={specActiveSuite.id}
                        type="text"
                        defaultValue={specActiveSuite.name}
                        onBlur={(e) => {
                          const input = e.target;
                          const saved = specActiveSuite.name;
                          if (!input.value.trim()) {
                            input.value = saved; // a suite always has a name
                          } else if (input.value.trim() !== saved) {
                            handleUpdateSuiteName(specActiveSuite.id, input.value.trim()).then((ok) => {
                              if (!ok) input.value = saved;
                            });
                          }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") e.currentTarget.blur();
                        }}
                        disabled={!hasSpecEditPermission}
                        title={hasSpecEditPermission ? "Suite name" : "Requires SPEC_EDIT permission"}
                        style={{
                          fontSize: "16px",
                          fontWeight: 700,
                          color: "#f9fafb",
                          backgroundColor: hasSpecEditPermission ? "#111827" : "transparent",
                          border: hasSpecEditPermission ? "1px solid #1f2937" : "none",
                          borderRadius: "4px",
                          padding: hasSpecEditPermission ? "3px 8px" : "0",
                          flex: 1,
                          minWidth: 0,
                          opacity: hasSpecEditPermission ? 1 : 0.85,
                        }}
                      />
                    </div>
                    <div style={{ fontSize: "12px", color: "#6b7280" }}>
                      {specActiveSuite.total_case_count} case{specActiveSuite.total_case_count === 1 ? "" : "s"}
                      {" · "}
                      {specActiveSuite.in_plan_count} in plan
                    </div>
                  </div>

                  <div style={{ flex: 1, padding: "20px", overflowY: "auto" }}>
                    {suiteCustomFieldValues && suiteCustomFieldValues.length > 0 ? (
                      suiteCustomFieldValues.map((entry) => (
                        <CustomFieldEditor
                          key={`${specActiveSuite.id}-${entry.definition.id}-${suiteCustomFieldResetKeyById[entry.definition.id] ?? 0}`}
                          entry={entry}
                          onChange={(value) => handleSuiteCustomFieldValueChange(entry.definition.id, value)}
                          disabled={!hasPlanManagePermission}
                          disabledTitle="Requires plan management permission"
                          errorMessage={suiteCustomFieldErrorById[entry.definition.id] ?? null}
                          isSaving={savingSuiteCustomFieldId === entry.definition.id}
                        />
                      ))
                    ) : suiteCustomFieldValues ? (
                      <div style={{ fontSize: "12px", color: "#6b7280" }}>
                        No custom fields defined for Test Suites yet.
                      </div>
                    ) : (
                      <div style={{ fontSize: "12px", color: "#6b7280" }}>Loading…</div>
                    )}
                  </div>
                </>
              ) : (
                <div
                  style={{
                    flex: 1,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "#6b7280",
                    fontSize: "13px",
                  }}
                >
                  Select a test case or suite to view its details.
                </div>
              )
            ) : (
              <ExecutionPane execution={execution} executionWorkspace={executionWorkspace} />
            )}
          </div>
        </div>
        )}

        {/* FOOTER BAR */}
        <footer
          style={{
            height: "24px",
            backgroundColor: "#090d16",
            borderTop: "1px solid #1f2937",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 16px",
            fontSize: "11px",
            color: "#6b7280",
          }}
        >
          <div>
            Keyboard Nav: <strong style={{ color: "#9ca3af" }}>j</strong> (down) |{" "}
            <strong style={{ color: "#9ca3af" }}>k</strong> (up) |{" "}
            <strong style={{ color: "#9ca3af" }}>p</strong> (pass) |{" "}
            <strong style={{ color: "#9ca3af" }}>f</strong> (fail) |{" "}
            <strong style={{ color: "#9ca3af" }}>b</strong> (block) |{" "}
            <strong style={{ color: "#9ca3af" }}>s</strong> (skip) |{" "}
            <strong style={{ color: "#9ca3af" }}>Ctrl+Enter</strong> (submit)
          </div>
          <div>
            Status: <strong style={{ color: "#10b981" }}>{syncStatus}</strong>
          </div>
        </footer>
      </div>
    </AppProvider>
  );
}
