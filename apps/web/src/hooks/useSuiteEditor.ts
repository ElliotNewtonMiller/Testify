import { useCallback, useEffect, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { CustomFieldValueEntry } from "../types";
import { authHeaders, jsonHeaders } from "../utils/session";

import { errorMessage } from "../api/errors";
export interface SuiteEditorOptions {
  workspaceMode: "EXECUTION" | "SPECIFICATION";
  selectedProjectId: string;
  selectedSuiteId: string | null;
  setSelectedSuiteId: Dispatch<SetStateAction<string | null>>;
  selectedSuiteIdRef: MutableRefObject<string | null>;
  refreshSpecTree: () => Promise<void>;
  showToast: (msg: string) => void;
  handleAuthExpiry: () => void;
  /** Re-runs the active search after a custom field value changes. */
  setFilterDataTick: Dispatch<SetStateAction<number>>;
  /** Bumped when an admin changes a custom field definition. */
  customFieldDefsVersion: number;
}

/**
 * Spec mode's suite editing: the selected suite's custom field values, the create/rename
 * form, renaming from Suite Details, and deleting suites.
 */
export function useSuiteEditor({
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
}: SuiteEditorOptions) {
  // Suite-level custom field values for whichever suite is selected in Specification mode --
  // shown/edited in Pane 3's Suite Details view (components/spec/SuiteDetailsPane.tsx).
  // Same shape as useCaseEditor's specCaseCustomFieldValues: clear-before-fetch discipline (the editors
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

  // Global admin-defined custom field values for whichever suite is selected in
  // Specification mode -- backs Pane 3's Suite Details view. Same lazy-per-entity,
  // clear-before-fetch pattern as useCaseEditor's specCaseCustomFieldValues.
  useEffect(() => {
    // Same fix as useCaseEditor's customFieldErrorById -- keyed only by definitionId, so it must be
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

  // Commits one suite custom field value edit via PUT -- mirrors useCaseEditor's
  // handleCustomFieldValueChange exactly, including the same stale-response race guard (selectedSuiteIdRef).
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
          throw new Error(errorMessage(data) || "Failed to save custom field value");
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
      if (!res.ok) throw new Error(errorMessage(data) || "Failed to save suite");
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
          throw new Error(errorMessage(data) || "Failed to rename suite");
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
          throw new Error(errorMessage(data) || "Failed to delete suite");
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
        throw new Error(errorMessage(data) || "Failed to delete suite");
      }
      if (selectedSuiteId === deleteSuitePrompt.id) setSelectedSuiteId(null);
      setDeleteSuitePrompt(null);
      showToast("Suite and its contents deleted");
      await refreshSpecTree();
    } catch (err: any) {
      showToast(err.message || "Failed to delete suite");
    }
  }, [deleteSuitePrompt, selectedProjectId, selectedSuiteId, refreshSpecTree, showToast]);

  return {
    suiteCustomFieldValues,
    setSuiteCustomFieldValues,
    savingSuiteCustomFieldId,
    setSavingSuiteCustomFieldId,
    suiteCustomFieldErrorById,
    setSuiteCustomFieldErrorById,
    suiteCustomFieldResetKeyById,
    setSuiteCustomFieldResetKeyById,
    suiteFormState,
    setSuiteFormState,
    isSavingSuiteForm,
    setIsSavingSuiteForm,
    deleteSuitePrompt,
    setDeleteSuitePrompt,
    handleSuiteCustomFieldValueChange,
    openCreateSuiteForm,
    openRenameSuiteForm,
    handleSaveSuiteForm,
    handleUpdateSuiteName,
    handleDeleteSuiteClick,
    handleConfirmDeleteSuite,
  };
}

export type SuiteEditor = ReturnType<typeof useSuiteEditor>;
