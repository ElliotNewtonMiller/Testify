import { useState, useEffect } from "react";
import { useHotkeyEngine } from "./hooks/useHotkeyEngine";
import { nextExecutionCaseIndex } from "./utils/executionCaseOrder";
import type { SuiteTreeNode } from "./components/VirtualizedSuiteTree";
import { AuthModal } from "./components/AuthModal";
import { AdminPanelModal } from "./components/AdminPanelModal";
import { ImportWizardModal } from "./components/ImportWizardModal";
import { ExportModal } from "./components/ExportModal";
import { ReportsView, parseReportsHash } from "./components/reports/ReportsView";
import { LoginPage } from "./components/LoginPage";
import { ForcedPasswordChange } from "./components/ForcedPasswordChange";
import { EntityManagementModal } from "./components/EntityManagementModal";
import { OVERWRITE_DENIED_MESSAGE, RUN_DENIED_MESSAGE } from "./app/messages";
import { permissionFlags } from "./utils/permissions";
import { buildSuiteNodes, pruneSuiteTree } from "./utils/suiteTree";
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
import { SuiteTreePane } from "./components/workspace/SuiteTreePane";
import { CaseListPane } from "./components/workspace/CaseListPane";

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
    selectedRunId,
    entityModalOpen,
    setEntityModalOpen,
    modalEntityType,
    modalActionType,
    modalSelectedItem,
    handleSaveEntity,
    refreshRunsList,
  } = scope;

  // The selected plan's cases for Execute mode (hooks/useExecutionWorkspace.ts).
  const executionWorkspace = useExecutionWorkspace(scope);
  const { workspace, refreshExecutionWorkspace } = executionWorkspace;

  // Spec mode's suite/case tree and plan membership (hooks/useSpecTree.ts).
  const specTree = useSpecTree({ selectedProjectId, selectedPlanId, showToast });
  const {
    showDeprecated,
    suiteExpandedMap,
    specData,
    removeFromPlanPrompt,
    setRemoveFromPlanPrompt,
    refreshSpecTree,
    handleToggleCaseInclusion,
    handleToggleSuiteInclusion,
  } = specTree;

  // Search & filter (hooks/useCaseSearch.ts).
  const caseSearch = useCaseSearch({
    selectedProjectId,
    selectedPlanId,
    selectedRunId,
    workspaceMode,
    specData,
    workspace,
    customFieldDefsVersion,
  });
  const { filterResult, setFilterDataTick, searchInputRef } = caseSearch;

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
    fsm,
    isRunMissing,
    verdictBlockReason,
    submitVerdict,
    queueCaseIndices,
    selectedVisiblePos,
    executionCaseOrderByCaseIndex,
    advanceToCase,
    crossSuiteNextCaseIndex,
  } = execution;

  // The actual workspace data fetch: Specification mode always needs the spec tree (it also
  // drives Pane 1's suite tree in BOTH modes -- see suiteNodes above). The Run dropdown's
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
    selectedSuiteId,
    setSelectedSuiteId,
    selectedSuiteIdRef,
    specSelectedCaseId,
    setSpecSelectedCaseId,
    specSelectedCaseIdRef,
    specCasesForSuite,
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
  const { specActiveCase } = caseEditor;

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
      // failureNotes here -- useExecution's case-load effect re-syncs it from the (about to
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
  const { hasSpecViewPermission, hasReportEmailPermission } = can;
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
          {/* PANE 1: SUITE TREE (components/workspace/SuiteTreePane.tsx) */}
          <SuiteTreePane
            caseSearch={caseSearch}
            execution={execution}
            executionWorkspace={executionWorkspace}
            specSelection={specSelection}
            specTree={specTree}
            suiteEditor={suiteEditor}
            execSuiteFilterId={execSuiteFilterId}
            setExecSuiteFilterId={setExecSuiteFilterId}
            setWorkspaceMode={setWorkspaceMode}
            suiteNodes={suiteNodes}
            suiteTreeWidth={suiteTreeWidth}
            workspaceMode={workspaceMode}
          />

          {/* DIVIDER: PANE 1 / PANE 2 */}
          <div
            onMouseDown={handleDividerMouseDown("tree")}
            onMouseEnter={() => setHoveredDivider("tree")}
            onMouseLeave={() => setHoveredDivider(null)}
            style={dividerStyle("tree")}
          />

          {/* PANE 2: CASE LIST / QUEUE (components/workspace/CaseListPane.tsx) */}
          <CaseListPane
            caseEditor={caseEditor}
            caseSearch={caseSearch}
            execution={execution}
            executionWorkspace={executionWorkspace}
            specSelection={specSelection}
            specTree={specTree}
            execSuiteFilterId={execSuiteFilterId}
            queueGridWidth={queueGridWidth}
            setExecSuiteFilterId={setExecSuiteFilterId}
            workspaceMode={workspaceMode}
          />

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
