import { useApp } from "../../app/AppContext";
import { OVERWRITE_DENIED_MESSAGE, REMOVED_CASE_MESSAGE } from "../../app/messages";
import type { Execution } from "../../hooks/useExecution";
import type { ExecutionWorkspace } from "../../hooks/useExecutionWorkspace";
import { CustomFieldEditor } from "../CustomFieldEditor";
import { FocusIndicatorBadge } from "../FocusIndicatorBadge";

interface ExecutionPaneProps {
  execution: Execution;
  executionWorkspace: ExecutionWorkspace;
}

/** Pane 3 in Execute mode: the active case, its steps and notes, and the verdict buttons. */
export function ExecutionPane({ execution, executionWorkspace }: ExecutionPaneProps) {
  const { showToast, can, scope } = useApp();
  const { hasExecuteRunPermission, hasSpecViewPermission } = can;
  const { projectsList } = scope;
  const { workspace, execWorkspaceStatus, refreshExecutionWorkspace } = executionWorkspace;
  const {
    activeCase,
    execCaseCustomFieldValues,
    activeExecCaseId,
    notesInputRef,
    failureNotes,
    setFailureNotes,
    notesDirtyRef,
    verdictBlockReason,
    fsm,
    submitVerdict,
    pendingVerdictRef,
    setExecutionDenied,
    nextVisibleCaseIndex,
    advanceToCase,
  } = execution;

  if (activeCase) {
    return (
      <>
        {/* CASE HEADER WITH VISUAL HOTKEY STATUS BADGE */}
        <div
          style={{
            padding: "16px 20px",
            borderBottom: "1px solid #1f2937",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
          }}
        >
          <div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "10px",
                marginBottom: "8px",
              }}
            >
              <span
                style={{
                  fontSize: "16px",
                  fontWeight: 700,
                  color: "#f9fafb",
                }}
              >
                {activeCase.external_id}
              </span>
              <span style={{ fontSize: "14px", color: "#9ca3af" }}>
                {activeCase.title}
              </span>
              <span
                style={{
                  fontSize: "11px",
                  padding: "2px 8px",
                  borderRadius: "4px",
                  backgroundColor: "#064e3b",
                  color: "#34d399",
                  fontWeight: 600,
                }}
              >
                v{activeCase.version_number} APPROVED
              </span>
            </div>
            <div style={{ fontSize: "12px", color: "#9ca3af" }}>
              {activeCase.summary}
            </div>
          </div>
        </div>

        {/* CASE DETAILS & STEP VERIFICATION */}
        <div style={{ flex: 1, padding: "20px", overflowY: "auto" }}>
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
            <div style={{ fontSize: "12px", color: "#d1d5db" }}>
              {activeCase.preconditions}
            </div>
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
            Ordered Step Verification Table
          </div>

          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "12px",
            }}
          >
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
              {activeCase.steps.map((step) => (
                <tr
                  key={step.id}
                  style={{
                    borderBottom: "1px solid #1f2937",
                    color: "#d1d5db",
                  }}
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

          {execCaseCustomFieldValues && execCaseCustomFieldValues.length > 0 && (
            <div style={{ marginTop: "16px" }}>
              {execCaseCustomFieldValues.map((entry) => (
                <CustomFieldEditor
                  key={`${activeExecCaseId}-${entry.definition.id}`}
                  entry={entry}
                  onChange={() => {}}
                  disabled
                  disabledTitle="Custom fields are read-only during execution -- edit them in Specification mode"
                />
              ))}
            </div>
          )}

          {/* NOTES & FAILURE REASON TEXTAREA (ZONE 4 INPUT) */}
          <div style={{ marginTop: "24px" }}>
            <label
              style={{
                display: "block",
                fontSize: "11px",
                fontWeight: 600,
                color: "#6b7280",
                textTransform: "uppercase",
                marginBottom: "6px",
              }}
            >
              Notes
            </label>
            <textarea
              ref={notesInputRef}
              value={failureNotes}
              disabled={Boolean(verdictBlockReason)}
              title={verdictBlockReason ?? undefined}
              onChange={(e) => {
                setFailureNotes(e.target.value);
                notesDirtyRef.current = true;
              }}
              onFocus={() => fsm.setZone("TEXT_INPUT")}
              onBlur={() => {
                fsm.setZone("EXECUTION_CONTAINER");
                // Unfocusing (click away, Tab, Esc) saves any unsubmitted notes
                // instead of silently discarding them. notesDirtyRef (not the
                // failureNotes state, which can be stale here -- see Ctrl+Enter's
                // own .blur() call) is what prevents double-submitting. No need to
                // clear failureNotes after submitting -- it's now this case's saved
                // note, and should keep showing exactly that.
                if (notesDirtyRef.current && failureNotes.trim()) {
                  submitVerdict(pendingVerdictRef.current, failureNotes);
                  notesDirtyRef.current = false;
                }
              }}
              placeholder="Type execution details or notes here... Single-key hotkeys auto-pause while typing. Press Ctrl+Enter to submit."
              style={{
                width: "100%",
                height: "80px",
                backgroundColor: "#111827",
                border: fsm.isInputFocused
                  ? "1px solid #3b82f6"
                  : "1px solid #1f2937",
                borderRadius: "6px",
                color: "#f9fafb",
                padding: "10px",
                fontSize: "12px",
                boxSizing: "border-box",
                outline: "none",
              }}
            />
          </div>
        </div>

        {/* DOCKED EXECUTION ACTION BAR */}
        <div
          style={{
            height: "56px",
            backgroundColor: "#111827",
            borderTop: "1px solid #1f2937",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 20px",
          }}
        >
          {activeCase?.removed_from_plan && (
            <span
              title={REMOVED_CASE_MESSAGE}
              style={{ fontSize: "11px", color: "#fbbf24", fontWeight: 600, marginRight: "12px", whiteSpace: "nowrap" }}
            >
              Removed from plan · read-only
            </span>
          )}
          {/* HOTKEY VERDICT BUTTONS (dimmed while the run is closed) */}
          <div
            style={{ display: "flex", gap: "10px", opacity: verdictBlockReason ? 0.4 : 1 }}
            title={verdictBlockReason ?? undefined}
          >
            <button
              onClick={() => {
                if (verdictBlockReason) return showToast(verdictBlockReason);
                if (!fsm.canExecute)
                  return showToast(
                    "Permission Denied: EXECUTE_RUN required",
                  );
                // Same rule as the verdict hotkeys: changing an existing result needs
                // EXECUTE_OVERWRITE (the server enforces it too).
                if (!fsm.canOverwrite) return setExecutionDenied(OVERWRITE_DENIED_MESSAGE);
                submitVerdict("PASSED");
                // Covers the case this button doesn't auto-advance from (the last case
                // in the list) -- without this, a note-only Ctrl+Enter afterward would
                // resubmit whatever stale verdict pendingVerdictRef last held instead of
                // PASSED, since staying on the same case means the case-load reset
                // effect (keyed on selectedIndex) never re-runs to correct it.
                pendingVerdictRef.current = "PASSED";
                if (nextVisibleCaseIndex !== undefined)
                  advanceToCase(nextVisibleCaseIndex);
              }}
              style={{
                backgroundColor: hasExecuteRunPermission
                  ? "#15803d"
                  : "#374151",
                color: hasExecuteRunPermission ? "#ffffff" : "#9ca3af",
                border: "none",
                padding: "8px 16px",
                borderRadius: "4px",
                fontWeight: 600,
                fontSize: "13px",
                cursor: hasExecuteRunPermission
                  ? "pointer"
                  : "not-allowed",
              }}
            >
              Pass
            </button>
            <button
              onClick={() => {
                if (verdictBlockReason) return showToast(verdictBlockReason);
                if (!fsm.canExecute)
                  return showToast(
                    "Permission Denied: EXECUTE_RUN required",
                  );
                // Same rule as the verdict hotkeys: changing an existing result needs
                // EXECUTE_OVERWRITE (the server enforces it too).
                if (!fsm.canOverwrite) return setExecutionDenied(OVERWRITE_DENIED_MESSAGE);
                submitVerdict("FAILED");
                pendingVerdictRef.current = "FAILED";
                if (notesInputRef.current) notesInputRef.current.focus();
              }}
              style={{
                backgroundColor: hasExecuteRunPermission
                  ? "#b91c1c"
                  : "#374151",
                color: hasExecuteRunPermission ? "#ffffff" : "#9ca3af",
                border: "none",
                padding: "8px 16px",
                borderRadius: "4px",
                fontWeight: 600,
                fontSize: "13px",
                cursor: hasExecuteRunPermission
                  ? "pointer"
                  : "not-allowed",
              }}
            >
              Fail
            </button>
            <button
              onClick={() => {
                if (verdictBlockReason) return showToast(verdictBlockReason);
                if (!fsm.canExecute)
                  return showToast(
                    "Permission Denied: EXECUTE_RUN required",
                  );
                // Same rule as the verdict hotkeys: changing an existing result needs
                // EXECUTE_OVERWRITE (the server enforces it too).
                if (!fsm.canOverwrite) return setExecutionDenied(OVERWRITE_DENIED_MESSAGE);
                submitVerdict("BLOCKED");
                pendingVerdictRef.current = "BLOCKED";
                if (notesInputRef.current) notesInputRef.current.focus();
              }}
              style={{
                backgroundColor: hasExecuteRunPermission
                  ? "#b45309"
                  : "#374151",
                color: hasExecuteRunPermission ? "#ffffff" : "#9ca3af",
                border: "none",
                padding: "8px 16px",
                borderRadius: "4px",
                fontWeight: 600,
                fontSize: "13px",
                cursor: hasExecuteRunPermission
                  ? "pointer"
                  : "not-allowed",
              }}
            >
              Block
            </button>
            <button
              onClick={() => {
                if (verdictBlockReason) return showToast(verdictBlockReason);
                if (!fsm.canExecute)
                  return showToast(
                    "Permission Denied: EXECUTE_RUN required",
                  );
                // Same rule as the verdict hotkeys: changing an existing result needs
                // EXECUTE_OVERWRITE (the server enforces it too).
                if (!fsm.canOverwrite) return setExecutionDenied(OVERWRITE_DENIED_MESSAGE);
                submitVerdict("SKIPPED");
                // Same reasoning as the Pass button above -- keeps a subsequent
                // note-only Ctrl+Enter correct when this is the last case (no advance).
                pendingVerdictRef.current = "SKIPPED";
                if (nextVisibleCaseIndex !== undefined)
                  advanceToCase(nextVisibleCaseIndex);
              }}
              style={{
                backgroundColor: hasExecuteRunPermission
                  ? "#4b5563"
                  : "#374151",
                color: hasExecuteRunPermission ? "#ffffff" : "#9ca3af",
                border: "none",
                padding: "8px 16px",
                borderRadius: "4px",
                fontWeight: 600,
                fontSize: "13px",
                cursor: hasExecuteRunPermission
                  ? "pointer"
                  : "not-allowed",
              }}
            >
              Skip
            </button>
          </div>

          {/* DOCKED HOTKEY STATUS BADGE */}
          <FocusIndicatorBadge
            status={fsm.hotkeyStatus}
            currentZone={fsm.currentZone}
            onToggleHotkeys={fsm.toggleHotkeys}
          />
        </div>
      </>
    );
  }

  // Execute mode with no case to show: say why, instead of a blank pane.
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "10px",
        color: "#6b7280",
        fontSize: "13px",
        textAlign: "center",
        padding: "24px",
      }}
    >
      {execWorkspaceStatus === "LOADING" ? (
        "Loading test cases…"
      ) : execWorkspaceStatus === "ERROR" ? (
        <>
          <span style={{ color: "#fca5a5" }}>Couldn't load this test plan's cases.</span>
          <button
            onClick={() => refreshExecutionWorkspace()}
            style={{
              padding: "5px 12px",
              backgroundColor: "#1f2937",
              border: "1px solid #374151",
              borderRadius: "4px",
              color: "#e5e7eb",
              fontSize: "12px",
              cursor: "pointer",
            }}
          >
            Retry
          </button>
        </>
      ) : execWorkspaceStatus === "NO_PLAN" ? (
        projectsList.length === 0
          ? "There are no projects yet."
          : "Select or create a test plan to start executing tests."
      ) : workspace.cases.length === 0 ? (
        hasSpecViewPermission
          ? "This test plan has no test cases yet. Add some in Spec mode."
          : "This test plan has no test cases yet."
      ) : (
        "No test case selected."
      )}
    </div>
  );
}
