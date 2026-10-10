import { useApp } from "../../app/AppContext";
import type { SpecSuiteNode } from "../../types";
import type { SuiteEditor } from "../../hooks/useSuiteEditor";
import { CustomFieldEditor } from "../CustomFieldEditor";

interface SuiteDetailsPaneProps {
  editor: SuiteEditor;
  specActiveSuite: SpecSuiteNode;
}

/** Pane 3 in Spec mode when a suite is selected: its name and custom fields. */
export function SuiteDetailsPane({ editor, specActiveSuite }: SuiteDetailsPaneProps) {
  const { can } = useApp();
  const { hasPlanManagePermission, hasSpecEditPermission } = can;
  const {
    suiteCustomFieldValues,
    savingSuiteCustomFieldId,
    suiteCustomFieldErrorById,
    suiteCustomFieldResetKeyById,
    handleSuiteCustomFieldValueChange,
    handleUpdateSuiteName,
  } = editor;

  return (
      <>
        {/* SUITE DETAILS -- name + custom fields. Replaces the case detail view
            whenever a suite (not a case) is the current selection; clicking a case
            in the list takes priority again (CaseDetailPane), matching how
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
  );
}
