import React, { useEffect, useState } from "react";
import { CustomFieldEditor } from "./CustomFieldEditor";
import type { CustomFieldValueEntry } from "../App";

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("auth_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

interface SuiteCustomFieldsPanelProps {
  suiteId: string;
  suiteName: string;
  canManagePlan: boolean;
  onClose: () => void;
}

/**
 * Inline panel (not a modal) showing a suite's global custom field values -- there is no
 * other suite-detail surface in this app, since selecting a suite in VirtualizedSuiteTree
 * only ever filters the case list. Docked above the case grid in Pane 2 rather than as a
 * modal, to stay consistent with this app's dense, keyboard-driven, non-interrupting UI.
 */
export function SuiteCustomFieldsPanel({ suiteId, suiteName, canManagePlan, onClose }: SuiteCustomFieldsPanelProps) {
  const [values, setValues] = useState<CustomFieldValueEntry[] | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [errorById, setErrorById] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/v1/test-suites/${suiteId}/custom-field-values`, {
          headers: authHeaders(),
        });
        if (!cancelled) setValues(res.ok ? (await res.json()).values : null);
      } catch {
        if (!cancelled) setValues(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [suiteId]);

  const handleChange = async (definitionId: string, value: unknown) => {
    setSavingId(definitionId);
    setErrorById((prev) => {
      const next = { ...prev };
      delete next[definitionId];
      return next;
    });
    try {
      const res = await fetch(`/api/v1/test-suites/${suiteId}/custom-field-values/${definitionId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ value }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || data.error || "Failed to save custom field value");
      }
      setValues((prev) =>
        prev ? prev.map((entry) => (entry.definition.id === definitionId ? { ...entry, value: data.value } : entry)) : prev,
      );
    } catch (err: any) {
      setErrorById((prev) => ({ ...prev, [definitionId]: err.message || "Failed to save" }));
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div
      style={{
        backgroundColor: "#111827",
        border: "1px solid #1f2937",
        borderRadius: "6px",
        padding: "12px",
        margin: "8px",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
        <div style={{ fontSize: "12px", fontWeight: 600, color: "#e5e7eb" }}>
          🏷️ Custom Fields — {suiteName}
        </div>
        <button
          onClick={onClose}
          style={{ background: "none", border: "none", color: "#94a3b8", fontSize: "14px", cursor: "pointer" }}
        >
          ✕
        </button>
      </div>

      {values === null && <div style={{ fontSize: "12px", color: "#64748b" }}>Loading...</div>}
      {values && values.length === 0 && (
        <div style={{ fontSize: "12px", color: "#64748b" }}>No custom fields defined for Test Suites yet.</div>
      )}
      {values &&
        values.map((entry) => (
          <CustomFieldEditor
            key={entry.definition.id}
            entry={entry}
            onChange={(value) => handleChange(entry.definition.id, value)}
            disabled={!canManagePlan}
            disabledTitle="Requires plan management permission"
            errorMessage={errorById[entry.definition.id] ?? null}
            isSaving={savingId === entry.definition.id}
          />
        ))}
    </div>
  );
}
