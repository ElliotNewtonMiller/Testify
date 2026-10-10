import type { Dispatch, SetStateAction } from "react";
import { useApp } from "../../app/AppContext";
import type { CaseSearch } from "../../hooks/useCaseSearch";
import type { Execution } from "../../hooks/useExecution";
import type { ExecutionWorkspace } from "../../hooks/useExecutionWorkspace";
import type { SpecSelection } from "../../hooks/useSpecSelection";
import type { SpecTree } from "../../hooks/useSpecTree";
import type { SuiteEditor } from "../../hooks/useSuiteEditor";
import { CaseFilterPanel } from "../CaseFilterPanel";
import { VirtualizedSuiteTree, type SuiteTreeNode } from "../VirtualizedSuiteTree";
import { expandableSuiteIds as listExpandableSuiteIds, flattenSuiteOptions } from "../../utils/suiteTree";

interface SuiteTreePaneProps {
  caseSearch: CaseSearch;
  execution: Execution;
  executionWorkspace: ExecutionWorkspace;
  specSelection: SpecSelection;
  specTree: SpecTree;
  suiteEditor: SuiteEditor;
  execSuiteFilterId: string | null;
  setExecSuiteFilterId: Dispatch<SetStateAction<string | null>>;
  setWorkspaceMode: Dispatch<SetStateAction<"EXECUTION" | "SPECIFICATION">>;
  suiteNodes: SuiteTreeNode[];
  suiteTreeWidth: number;
  workspaceMode: "EXECUTION" | "SPECIFICATION";
}

/** Pane 1: the Execute/Spec toggle, search & filter, the suite form and the suite tree. */
export function SuiteTreePane({
  caseSearch,
  execution,
  executionWorkspace,
  specSelection,
  specTree,
  suiteEditor,
  execSuiteFilterId,
  setExecSuiteFilterId,
  setWorkspaceMode,
  suiteNodes,
  suiteTreeWidth,
  workspaceMode,
}: SuiteTreePaneProps) {
  const { can, scope } = useApp();
  const { hasPlanManagePermission, hasRunManagePermission, hasSpecCreatePermission, hasSpecDeletePermission, hasSpecEditPermission, hasSpecViewPermission } = can;
  const { handleToggleRunClosed, isTogglingRun, selectedPlanId, selectedRun, selectedRunId } = scope;
  const {
    caseFilter,
    caseFilterFields,
    filterError,
    filterResult,
    loadCaseFilterFields,
    searchInputRef,
    setCaseFilter,
  } = caseSearch;
  const {
    activeCase,
    selectedIndex,
    setSelectedIndex,
    visibleCaseIndices,
  } = execution;
  const {
    workspace,
  } = executionWorkspace;
  const {
    canDropSpecItemsOn,
    dragPayload,
    handleSpecDragStart,
    handleSpecDrop,
    handleSpecSuiteClick,
    selectedSuiteId,
    setDragPayload,
    specSelectedSuiteIds,
  } = specSelection;
  const {
    handleToggleSuiteInclusion,
    setShowDeprecated,
    setSuiteExpandedMap,
    showDeprecated,
    specData,
    suiteExpandedMap,
  } = specTree;
  const {
    deleteSuitePrompt,
    handleConfirmDeleteSuite,
    handleDeleteSuiteClick,
    handleSaveSuiteForm,
    isSavingSuiteForm,
    openCreateSuiteForm,
    openRenameSuiteForm,
    setDeleteSuitePrompt,
    setSuiteFormState,
    suiteFormState,
  } = suiteEditor;

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

  return (
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
  );
}
