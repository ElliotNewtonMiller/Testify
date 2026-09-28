import React, { useEffect, useRef, useState } from "react";
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

  // Mirrors the suiteId prop for reads from inside an already-in-flight async closure (see
  // handleChange) -- a blur-triggered autosave for a suite the user has since navigated away
  // from must not let its late-arriving response patch the now-different suite's values.
  const suiteIdRef = useRef(suiteId);
  useEffect(() => {
    suiteIdRef.current = suiteId;
  }, [suiteId]);

  useEffect(() => {
    // Clear synchronously before fetching the new suite's values -- the editors are
    // uncontrolled (defaultValue-driven), so a still-mounted editor showing the PREVIOUS
    // suite's values while this fetch is in flight would never pick up the fresh values once
    // they arrive (an uncontrolled DOM input ignores later defaultValue prop updates).
    setValues(null);
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
    const requestSuiteId = suiteId;
    setSavingId(definitionId);
    setErrorById((prev) => {
      const next = { ...prev };
      delete next[definitionId];
      return next;
    });
    try {
      const res = await fetch(`/api/v1/test-suites/${requestSuiteId}/custom-field-values/${definitionId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ value }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || data.error || "Failed to save custom field value");
      }
      // The save genuinely succeeded against requestSuiteId's own data regardless -- but if
      // the panel has since switched to a different suite, `values` now holds that suite's
      // data, and patching it here would silently overwrite it with this stale response.
      if (suiteIdRef.current === requestSuiteId) {
        setValues((prev) =>
          prev ? prev.map((entry) => (entry.definition.id === definitionId ? { ...entry, value: data.value } : entry)) : prev,
        );
      }
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
            key={`${suiteId}-${entry.definition.id}`}
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
