import { useApp } from "../../app/AppContext";
import type { CaseEditor } from "../../hooks/useCaseEditor";
import { autoGrowTextarea } from "../../utils/autoGrowTextarea";
import { CustomFieldEditor } from "../CustomFieldEditor";

interface CaseDetailPaneProps {
  editor: CaseEditor;
  specSelectedCaseId: string | null;
}

/** Pane 3 in Spec mode when a case is selected: its header, lifecycle, content, steps and custom fields. */
export function CaseDetailPane({ editor, specSelectedCaseId }: CaseDetailPaneProps) {
  const { can } = useApp();
  const { hasPlanManagePermission, hasSpecEditPermission, hasSpecApprovePermission, hasSpecDeletePermission } = can;
  const {
    specCaseCustomFieldValues,
    savingCustomFieldId,
    customFieldErrorById,
    customFieldResetKeyById,
    deleteCasePrompt,
    setDeleteCasePrompt,
    stepsDraft,
    isCreatingDraft,
    isApprovingVersion,
    isTransitioningVersion,
    isSavingSteps,
    specEditError,
    stepActionRefs,
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
    handleDeleteCaseClick,
    handleConfirmDeleteCase,
    specActiveCase,
    specVersionDetail,
  } = editor;
  if (!specActiveCase) return null;

  return (
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
  );
}
