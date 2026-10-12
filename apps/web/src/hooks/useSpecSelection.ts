import { useEffect, useRef, useState } from "react";
import type React from "react";
import type { SpecCaseGridItem } from "../components/SpecCaseListGrid";
import type { SuiteTreeNode } from "../components/VirtualizedSuiteTree";
import type { SpecTreeData } from "../types";
import {
  findSuiteNode,
  rangeBetween,
  suiteInfoById as buildSuiteInfoById,
  visibleSuiteOrder as listVisibleSuiteOrder,
} from "../utils/suiteTree";
import { jsonHeaders } from "../utils/session";

import { errorMessage } from "../api/errors";
import { api } from "../api/routes";
export interface SpecSelectionOptions {
  workspaceMode: "EXECUTION" | "SPECIFICATION";
  selectedProjectId: string;
  specData: SpecTreeData | null;
  /** The active search/filter's matches, or null when none is active. */
  filterResult: { caseIds: Set<string>; suiteIds: Set<string> } | null;
  /** The suite tree as shown. */
  suiteNodes: SuiteTreeNode[];
  suiteExpandedMap: Record<string, boolean>;
  refreshSpecTree: () => Promise<void>;
  showToast: (msg: string) => void;
  handleAuthExpiry: () => void;
}

/**
 * Spec mode selection: the selected suite and case, Shift/Ctrl multi-select, the case list
 * for the selected suite, and drag-and-drop moving of suites and cases.
 */
export function useSpecSelection({
  workspaceMode,
  selectedProjectId,
  specData,
  filterResult,
  suiteNodes,
  suiteExpandedMap,
  refreshSpecTree,
  showToast,
  handleAuthExpiry,
}: SpecSelectionOptions) {
  // Spec-mode multi-select (Shift = range, Ctrl/Cmd = toggle) and drag-and-drop moving. A
  // selection lives in one list at a time; the anchors are where a Shift-range starts.
  const [specSelectedSuiteIds, setSpecSelectedSuiteIds] = useState<Set<string>>(() => new Set());
  const [specSelectedCaseIds, setSpecSelectedCaseIds] = useState<Set<string>>(() => new Set());
  const suiteSelectAnchorRef = useRef<string | null>(null);
  const caseSelectAnchorRef = useRef<string | null>(null);
  const [dragPayload, setDragPayload] = useState<{ kind: "SUITES" | "CASES"; ids: string[] } | null>(null);

  const [selectedSuiteId, setSelectedSuiteId] = useState<string | null>(null);

  // Mirrors selectedSuiteId for reads from inside an already-in-flight async closure (see
  // handleSuiteCustomFieldValueChange) -- same race this file already guards against for
  // specSelectedCaseIdRef below, just for the suite-details custom fields instead.
  const selectedSuiteIdRef = useRef<string | null>(null);
  useEffect(() => {
    selectedSuiteIdRef.current = selectedSuiteId;
  }, [selectedSuiteId]);

  const [specSelectedCaseId, setSpecSelectedCaseId] = useState<string | null>(
    null,
  );

  // Mirrors specSelectedCaseId for reads from inside an already-in-flight async closure (see
  // handleCustomFieldValueChange) -- a blur-triggered custom-field autosave for a case the
  // user has since navigated away from must not let its late-arriving response patch the
  // now-different case's displayed values.
  const specSelectedCaseIdRef = useRef<string | null>(null);
  useEffect(() => {
    specSelectedCaseIdRef.current = specSelectedCaseId;
  }, [specSelectedCaseId]);

  // Spec-mode multi-select resets on mode/project change; Escape clears it (outside inputs).
  useEffect(() => {
    setSpecSelectedSuiteIds(new Set());
    setSpecSelectedCaseIds(new Set());
  }, [workspaceMode, selectedProjectId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")) return;
      setSpecSelectedSuiteIds(new Set());
      setSpecSelectedCaseIds(new Set());
    };
    // A virtualized source row can unmount mid-drag (its own dragend never fires), so any
    // drag ending anywhere also clears the drag state.
    const onDragEnd = () => setTimeout(() => setDragPayload(null), 0);
    window.addEventListener("keydown", onKey);
    window.addEventListener("dragend", onDragEnd);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("dragend", onDragEnd);
    };
  }, []);

  // Cases visible in Pane 2 for Specification mode: the whole project, or just the
  // currently selected suite's direct cases if one is selected in the tree.
  const specCasesForSuite: SpecCaseGridItem[] = specData
    ? specData.cases.filter(
        (c) =>
          (!selectedSuiteId || c.test_suite_id === selectedSuiteId) &&
          (!filterResult || filterResult.caseIds.has(c.id)),
      )
    : [];

  // Visible tree order (collapsed children excluded) -- what a Shift-range spans in the tree.
  const visibleSuiteOrder = listVisibleSuiteOrder(suiteNodes, suiteExpandedMap);
  const suiteInfoById = buildSuiteInfoById(specData?.suites ?? []);

  const clearSpecMultiSelect = () => {
    setSpecSelectedSuiteIds(new Set());
    setSpecSelectedCaseIds(new Set());
  };

  const handleSpecSuiteClick = (suiteId: string, mods?: { shift: boolean; toggle: boolean }) => {
    if (mods?.shift || mods?.toggle) {
      setSpecSelectedCaseIds(new Set());
      const base = specSelectedSuiteIds.size > 0 ? specSelectedSuiteIds : new Set(selectedSuiteId ? [selectedSuiteId] : []);
      if (mods.shift) {
        const from = suiteSelectAnchorRef.current ?? selectedSuiteId ?? suiteId;
        setSpecSelectedSuiteIds(new Set(rangeBetween(visibleSuiteOrder, from, suiteId)));
      } else {
        const next = new Set(base);
        if (next.has(suiteId)) next.delete(suiteId);
        else next.add(suiteId);
        setSpecSelectedSuiteIds(next);
        suiteSelectAnchorRef.current = suiteId;
      }
      return;
    }
    // Plain click: unchanged behavior (select, Pane 3 shows the suite), selection = this row.
    setSelectedSuiteId(suiteId);
    setSpecSelectedCaseId(null);
    setSpecSelectedSuiteIds(new Set([suiteId]));
    setSpecSelectedCaseIds(new Set());
    suiteSelectAnchorRef.current = suiteId;
  };

  const handleSpecCaseClick = (caseId: string, mods?: { shift: boolean; toggle: boolean }) => {
    if (mods?.shift || mods?.toggle) {
      setSpecSelectedSuiteIds(new Set());
      const order = specCasesForSuite.map((c) => c.id);
      const base = specSelectedCaseIds.size > 0 ? specSelectedCaseIds : new Set(specSelectedCaseId ? [specSelectedCaseId] : []);
      if (mods.shift) {
        const from = caseSelectAnchorRef.current ?? specSelectedCaseId ?? caseId;
        setSpecSelectedCaseIds(new Set(rangeBetween(order, from, caseId)));
      } else {
        const next = new Set(base);
        if (next.has(caseId)) next.delete(caseId);
        else next.add(caseId);
        setSpecSelectedCaseIds(next);
        caseSelectAnchorRef.current = caseId;
      }
      return;
    }
    setSpecSelectedCaseId(caseId);
    setSpecSelectedCaseIds(new Set([caseId]));
    setSpecSelectedSuiteIds(new Set());
    caseSelectAnchorRef.current = caseId;
  };

  // Dragging a selected row drags the whole selection of that kind; otherwise just that row.
  const handleSpecDragStart = (kind: "SUITES" | "CASES", id: string, e: React.DragEvent) => {
    const selection = kind === "SUITES" ? specSelectedSuiteIds : specSelectedCaseIds;
    const ids = selection.has(id) ? [...selection] : [id];
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("application/x-testify-move", JSON.stringify({ kind, ids }));
    // Deferred: changing the DOM inside dragstart (the tree adds its "top level" zone) can
    // make the browser cancel the drag.
    setTimeout(() => setDragPayload({ kind, ids }), 0);
  };

  const canDropSpecItemsOn = (targetSuiteId: string | null): boolean => {
    if (!dragPayload) return false;
    if (dragPayload.kind === "CASES") return targetSuiteId !== null;
    if (targetSuiteId === null) return true;
    const targetPath = suiteInfoById.get(targetSuiteId)?.path ?? "";
    // A suite can't go into itself or one of its own sub-suites.
    return !dragPayload.ids.some((id) => {
      const path = suiteInfoById.get(id)?.path;
      return id === targetSuiteId || (path ? targetPath.startsWith(`${path}/`) : false);
    });
  };

  const handleSpecDrop = async (targetSuiteId: string | null) => {
    const payload = dragPayload;
    setDragPayload(null);
    if (!payload || !selectedProjectId) return;
    try {
      const res = await fetch(api.move(selectedProjectId), {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          ...(payload.kind === "SUITES" ? { suite_ids: payload.ids } : { case_ids: payload.ids }),
          target_suite_id: targetSuiteId,
        }),
      });
      const data = await res.json().catch(() => ({}) as any);
      if (!res.ok) {
        if (res.status === 401) {
          handleAuthExpiry();
          return;
        }
        throw new Error(errorMessage(data) || "Failed to move");
      }
      const moved = (data.moved_suite_count ?? 0) + (data.moved_case_count ?? 0);
      const noun =
        payload.kind === "SUITES"
          ? `${data.moved_suite_count} suite${data.moved_suite_count === 1 ? "" : "s"}`
          : `${data.moved_case_count} case${data.moved_case_count === 1 ? "" : "s"}`;
      const where = targetSuiteId ? suiteInfoById.get(targetSuiteId)?.name ?? "the suite" : "the top level";
      showToast(moved > 0 ? `Moved ${noun} to ${where}` : `Already in ${where}`);
      clearSpecMultiSelect();
      await refreshSpecTree();
    } catch (err: any) {
      showToast(err.message || "Failed to move");
    }
  };

  // Backs Pane 3's Suite Details view (SuiteDetailsPane) -- selectedSuiteId only carries an id, so the
  // full node (name, case counts) has to be looked up from the nested tree each render.
  const specActiveSuite =
    workspaceMode === "SPECIFICATION" && selectedSuiteId && specData
      ? findSuiteNode(specData.suites, selectedSuiteId)
      : null;

  return {
    specSelectedSuiteIds,
    setSpecSelectedSuiteIds,
    specSelectedCaseIds,
    setSpecSelectedCaseIds,
    suiteSelectAnchorRef,
    caseSelectAnchorRef,
    dragPayload,
    setDragPayload,
    selectedSuiteId,
    setSelectedSuiteId,
    selectedSuiteIdRef,
    specSelectedCaseId,
    setSpecSelectedCaseId,
    specSelectedCaseIdRef,
    specCasesForSuite,
    visibleSuiteOrder,
    suiteInfoById,
    clearSpecMultiSelect,
    handleSpecSuiteClick,
    handleSpecCaseClick,
    handleSpecDragStart,
    canDropSpecItemsOn,
    handleSpecDrop,
    specActiveSuite,
  };
}

export type SpecSelection = ReturnType<typeof useSpecSelection>;
