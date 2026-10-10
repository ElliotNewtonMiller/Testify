import type { Dispatch, SetStateAction } from "react";
import { useApp } from "../../app/AppContext";
import type { CaseEditor } from "../../hooks/useCaseEditor";
import type { CaseSearch } from "../../hooks/useCaseSearch";
import type { Execution } from "../../hooks/useExecution";
import type { ExecutionWorkspace } from "../../hooks/useExecutionWorkspace";
import type { SpecSelection } from "../../hooks/useSpecSelection";
import type { SpecTree } from "../../hooks/useSpecTree";
import { SpecCaseListGrid } from "../SpecCaseListGrid";
import { TestCaseQueueGrid } from "../TestCaseQueueGrid";
import { findSuiteNode } from "../../utils/suiteTree";

interface CaseListPaneProps {
  caseEditor: CaseEditor;
  caseSearch: CaseSearch;
  execution: Execution;
  executionWorkspace: ExecutionWorkspace;
  specSelection: SpecSelection;
  specTree: SpecTree;
  execSuiteFilterId: string | null;
  queueGridWidth: number;
  setExecSuiteFilterId: Dispatch<SetStateAction<string | null>>;
  workspaceMode: "EXECUTION" | "SPECIFICATION";
}

/** Pane 2: Spec mode's case list (with the new-case form) or Execute mode's queue. */
export function CaseListPane({
  caseEditor,
  caseSearch,
  execution,
  executionWorkspace,
  specSelection,
  specTree,
  execSuiteFilterId,
  queueGridWidth,
  setExecSuiteFilterId,
  workspaceMode,
}: CaseListPaneProps) {
  const { can } = useApp();
  const { hasPlanManagePermission, hasSpecCreatePermission, hasSpecEditPermission } = can;
  const {
    handleCreateCase,
    isCaseCreateFormOpen,
    isCreatingCase,
    newCaseExecutionType,
    newCasePriority,
    newCaseTitle,
    setIsCaseCreateFormOpen,
    setNewCaseExecutionType,
    setNewCasePriority,
    setNewCaseTitle,
  } = caseEditor;
  const {
    filterResult,
  } = caseSearch;
  const {
    failedCount,
    passedCount,
    queueCaseIndices,
    selectedVisiblePos,
    setSelectedIndex,
  } = execution;
  const {
    workspace,
  } = executionWorkspace;
  const {
    handleSpecCaseClick,
    handleSpecDragStart,
    selectedSuiteId,
    setDragPayload,
    specCasesForSuite,
    specSelectedCaseId,
    specSelectedCaseIds,
  } = specSelection;
  const {
    handleToggleCaseInclusion,
    pendingToggleId,
    specData,
  } = specTree;

  return (
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
          scrollToCaseId={specSelectedCaseId}
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
  );
}
