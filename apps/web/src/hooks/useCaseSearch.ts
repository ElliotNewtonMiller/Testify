import { useCallback, useEffect, useRef, useState } from "react";
import {
  CaseFilterField,
  CaseFilterState,
  EMPTY_CASE_FILTER,
  isFieldAvailable,
  toApiFilters,
} from "../components/CaseFilterPanel";
import type { SpecTreeData, WorkspaceData } from "../types";
import { authHeaders, jsonHeaders } from "../utils/session";

import { errorMessage } from "../api/errors";
export interface CaseSearchOptions {
  selectedProjectId: string;
  selectedPlanId: string;
  selectedRunId: string;
  workspaceMode: "EXECUTION" | "SPECIFICATION";
  /** The loaded data the search re-runs against when it changes. */
  specData: SpecTreeData | null;
  workspace: WorkspaceData;
  /** Bumped when an admin changes a custom field definition. */
  customFieldDefsVersion: number;
}

/**
 * Search & filter (Pane 1, under the Execute/Spec toggle): the filter rows, the field
 * catalog behind "+ Filter", and the server-side search that narrows both modes' lists.
 */
export function useCaseSearch({
  selectedProjectId,
  selectedPlanId,
  selectedRunId,
  workspaceMode,
  specData,
  workspace,
  customFieldDefsVersion,
}: CaseSearchOptions) {
  // Search & filter (Pane 1, under the Execute/Spec toggle). Evaluated only on the server
  // (POST .../case-search); filterResult holds the matching ids, or null when nothing is
  // active (show everything). Session-only, not persisted.
  const [caseFilter, setCaseFilter] = useState<CaseFilterState>(EMPTY_CASE_FILTER);
  const [caseFilterFields, setCaseFilterFields] = useState<CaseFilterField[]>([]);
  const [filterResult, setFilterResult] = useState<{ caseIds: Set<string>; suiteIds: Set<string> } | null>(null);
  const [filterError, setFilterError] = useState<string | null>(null);
  // Bumped after edits that can change whether a case matches but don't replace specData/
  // workspace (custom field value saves), so the active filter re-evaluates.
  const [filterDataTick, setFilterDataTick] = useState(0);
  const caseSearchRequestSeq = useRef(0);
  const caseFilterFieldsRequestSeq = useRef(0);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // ---- Search & filter ----
  // Field catalog for the "+ Filter" property picker. Re-fetched on project change and
  // whenever "+ Filter" is clicked (picks up custom fields added since). Rows naming a field
  // that no longer exists (deleted, or a different project) are dropped once a catalog for
  // the current project actually arrives -- never on a failed fetch.
  const loadCaseFilterFields = useCallback(async () => {
    const seq = ++caseFilterFieldsRequestSeq.current;
    if (!selectedProjectId) return;
    try {
      const res = await fetch(`/api/v1/projects/${selectedProjectId}/case-search/fields`, { headers: authHeaders() });
      if (seq !== caseFilterFieldsRequestSeq.current || !res.ok) return;
      const data = await res.json();
      if (seq !== caseFilterFieldsRequestSeq.current) return;
      const fields: CaseFilterField[] = data.fields || [];
      setCaseFilterFields(fields);
      const keys = new Set(fields.map((f) => f.key));
      setCaseFilter((prev) => {
        const kept = prev.filters.filter((r) => r.field === "" || keys.has(r.field));
        return kept.length === prev.filters.length ? prev : { ...prev, filters: kept };
      });
    } catch {
      // Leave the previous catalog in place; the panel still works with what it has.
    }
  }, [selectedProjectId]);

  useEffect(() => {
    loadCaseFilterFields();
  }, [loadCaseFilterFields]);
  // A custom field changed in the Admin Panel: refresh the field list (a deleted field's filter
  // row drops out) and re-run the current search, since stored values may have changed too.
  useEffect(() => {
    if (customFieldDefsVersion === 0) return;
    loadCaseFilterFields();
    setFilterDataTick((t) => t + 1);
  }, [customFieldDefsVersion, loadCaseFilterFields]);

  const caseFilterFieldsByKey = new Map(caseFilterFields.map((f) => [f.key, f]));
  const filterContext = {
    mode: workspaceMode,
    hasPlan: Boolean(selectedPlanId),
    hasRun: Boolean(selectedRunId),
  };
  const apiCaseFilters = toApiFilters(caseFilter.filters, caseFilterFieldsByKey, (f) =>
    isFieldAvailable(f, filterContext),
  );
  const trimmedCaseQuery = caseFilter.q.trim();
  const isCaseFilterActive = trimmedCaseQuery !== "" || apiCaseFilters.length > 0;
  // Stable string key so the effect below only re-runs when the effective request changes,
  // not on every keystroke that doesn't change it (e.g. trailing spaces, an empty new row).
  const caseFilterRequestKey = JSON.stringify({ q: trimmedCaseQuery, filters: apiCaseFilters });

  useEffect(() => {
    // Bumped unconditionally (before any early return) so clearing the filter or switching
    // context also invalidates any request still in flight -- same discipline as
    // runsListRequestSeq.
    const seq = ++caseSearchRequestSeq.current;
    if (!isCaseFilterActive || !selectedProjectId) {
      setFilterResult(null);
      setFilterError(null);
      return;
    }
    const { q, filters } = JSON.parse(caseFilterRequestKey) as {
      q: string;
      filters: Array<{ field: string; op: string; value?: unknown }>;
    };
    // Only send plan/build when a filter needs them, so a plan/run switch that's still
    // settling can't 404 an unrelated search.
    const needsPlan = filters.some((f) => f.field === "in_plan");
    const needsBuild = filters.some((f) => f.field === "verdict");
    const handle = setTimeout(async () => {
      try {
        const res = await fetch(`/api/v1/projects/${selectedProjectId}/case-search`, {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({
            q,
            filters,
            ...(needsPlan && selectedPlanId ? { plan_id: selectedPlanId } : {}),
            ...(needsBuild && selectedRunId ? { build_id: selectedRunId } : {}),
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (seq !== caseSearchRequestSeq.current) return;
        if (!res.ok) {
          setFilterError(
            errorMessage(data) || "Search failed",
          );
          return;
        }
        setFilterError(null);
        setFilterResult({
          caseIds: new Set<string>(data.case_ids || []),
          suiteIds: new Set<string>(data.suite_ids || []),
        });
      } catch {
        if (seq === caseSearchRequestSeq.current) setFilterError("Search failed: network error");
      }
    }, 250);
    return () => clearTimeout(handle);
    // specData/workspace identity + filterDataTick: re-evaluate after data changes (a
    // verdict recorded, a case edited, a custom field value saved) so matches stay current.
  }, [
    caseFilterRequestKey,
    isCaseFilterActive,
    selectedProjectId,
    selectedPlanId,
    selectedRunId,
    workspaceMode,
    specData,
    workspace,
    filterDataTick,
  ]);

  return {
    caseFilter,
    setCaseFilter,
    caseFilterFields,
    filterResult,
    filterError,
    setFilterDataTick,
    loadCaseFilterFields,
    searchInputRef,
  };
}

export type CaseSearch = ReturnType<typeof useCaseSearch>;
