import { useState, useEffect } from "react";
import { useHotkeyEngine } from "./hooks/useHotkeyEngine";
import { nextExecutionCaseIndex } from "./utils/executionCaseOrder";
import { TestCaseQueueGrid } from "./components/TestCaseQueueGrid";
import {
  VirtualizedSuiteTree,
  SuiteTreeNode,
} from "./components/VirtualizedSuiteTree";
import { SpecCaseListGrid } from "./components/SpecCaseListGrid";
import { AuthModal } from "./components/AuthModal";
import { AdminPanelModal } from "./components/AdminPanelModal";
import { ImportWizardModal } from "./components/ImportWizardModal";
import { ExportModal } from "./components/ExportModal";
import { ReportsView, parseReportsHash } from "./components/reports/ReportsView";
import { LoginPage } from "./components/LoginPage";
import { ForcedPasswordChange } from "./components/ForcedPasswordChange";
import { CaseFilterPanel } from "./components/CaseFilterPanel";
import { EntityManagementModal } from "./components/EntityManagementModal";
import { OVERWRITE_DENIED_MESSAGE, RUN_DENIED_MESSAGE } from "./app/messages";
import { permissionFlags } from "./utils/permissions";
import {
  buildSuiteNodes,
  expandableSuiteIds as listExpandableSuiteIds,
  findSuiteNode,
  flattenSuiteOptions,
  pruneSuiteTree,
} from "./utils/suiteTree";
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
import { useSpecTree } from "./hooks/useSpecTree";
import { useSpecSelection } from "./hooks/useSpecSelection";
import { useCaseEditor } from "./hooks/useCaseEditor";
import { useSuiteEditor } from "./hooks/useSuiteEditor";
import { CaseDetailPane } from "./components/spec/CaseDetailPane";
import { SuiteDetailsPane } from "./components/spec/SuiteDetailsPane";

/** A Reports link (#/reports/...) opened directly: the view, tab and scope to start on. */
const INITIAL_REPORTS_LINK = typeof window !== "undefined" ? parseReportsHash(window.location.hash) : null;

export default function App() {
  // Bumped when an admin creates, changes or deletes a custom field definition (Admin Panel),
  // so the open case's/suite's values and the filter's field list reload instead of showing
  // what they showed before the change.
  const [customFieldDefsVersion, setCustomFieldDefsVersion] = useState(0);
  const { toastMessage, showToast } = useToast();

  const { suiteTreeWidth, queueGridWidth, setHoveredDivider, handleDividerMouseDown, dividerStyle } = usePaneLayout();

  // Specification / Execution mode toggle (Pane 1 header) & Specification-mode state
  const [workspaceMode, setWorkspaceMode] = useState<"EXECUTION" | "SPECIFICATION">(
    "SPECIFICATION",
  );
  // Execute mode's own suite selection -- narrows the queue grid to that suite's cases. Kept
  // separate from selectedSuiteId (Spec mode's, which also drives Pane 3's Suite Details) so
  // browsing suites in Spec mode never silently narrows the execution queue, or vice versa.
  // Clicking the selected suite again (or the ✕ in the queue header) clears it.
  const [execSuiteFilterId, setExecSuiteFilterId] = useState<string | null>(null);

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

  // Spec mode's suite/case tree and plan membership (hooks/useSpecTree.ts).
  const specTree = useSpecTree({ selectedProjectId, selectedPlanId, showToast });
  const {
    showDeprecated,
    setShowDeprecated,
    suiteExpandedMap,
    setSuiteExpandedMap,
    specData,
    pendingToggleId,
    removeFromPlanPrompt,
    setRemoveFromPlanPrompt,
    refreshSpecTree,
    handleToggleCaseInclusion,
    handleToggleSuiteInclusion,
  } = specTree;

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

  // Spec mode: selection, multi-select and drag-and-drop moving (hooks/useSpecSelection.ts).
  const specSelection = useSpecSelection({
    workspaceMode,
    selectedProjectId,
    specData,
    filterResult,
    suiteNodes,
    suiteExpandedMap,
    refreshSpecTree,
    showToast,
    handleAuthExpiry,
  });
  const {
    specSelectedSuiteIds,
    specSelectedCaseIds,
    dragPayload,
    setDragPayload,
    selectedSuiteId,
    setSelectedSuiteId,
    selectedSuiteIdRef,
    specSelectedCaseId,
    setSpecSelectedCaseId,
    specSelectedCaseIdRef,
    specCasesForSuite,
    handleSpecSuiteClick,
    handleSpecCaseClick,
    handleSpecDragStart,
    canDropSpecItemsOn,
    handleSpecDrop,
    specActiveSuite,
  } = specSelection;

  // Spec mode: editing the selected case (hooks/useCaseEditor.ts).
  const caseEditor = useCaseEditor({
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
  });
  const {
    isCaseCreateFormOpen,
    setIsCaseCreateFormOpen,
    newCaseTitle,
    setNewCaseTitle,
    newCasePriority,
    setNewCasePriority,
    newCaseExecutionType,
    setNewCaseExecutionType,
    isCreatingCase,
    handleCreateCase,
    specActiveCase,
  } = caseEditor;

  // Spec mode: editing suites (hooks/useSuiteEditor.ts).
  const suiteEditor = useSuiteEditor({
    workspaceMode,
    selectedProjectId,
    selectedSuiteId,
    setSelectedSuiteId,
    selectedSuiteIdRef,
    refreshSpecTree,
    showToast,
    handleAuthExpiry,
    setFilterDataTick,
    customFieldDefsVersion,
  });
  const {
    suiteFormState,
    setSuiteFormState,
    isSavingSuiteForm,
    deleteSuitePrompt,
    setDeleteSuitePrompt,
    openCreateSuiteForm,
    openRenameSuiteForm,
    handleSaveSuiteForm,
    handleDeleteSuiteClick,
    handleConfirmDeleteSuite,
  } = suiteEditor;

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

  const toggleAllSuitesExpanded = () => {
    const next = !allSuitesExpanded;
    setSuiteExpandedMap((prev) => {
      const updated = { ...prev };
      for (const id of expandableSuiteIds) updated[id] = next;
      return updated;
    });
  };

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
                <CaseDetailPane editor={caseEditor} specSelectedCaseId={specSelectedCaseId} />
              ) : specActiveSuite ? (
                <SuiteDetailsPane editor={suiteEditor} specActiveSuite={specActiveSuite} />
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
