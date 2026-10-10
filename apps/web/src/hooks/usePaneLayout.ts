import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";

/** The resizable widths of Pane 1 (Suite Tree) and Pane 2 (case list), and their dividers. */
export function usePaneLayout() {
  // Resizable 3-pane layout widths (Pane 1: Suite Tree, Pane 2: Spec/Queue Grid). Not
  // persisted to localStorage -- resets to defaults every session/reload, per direct request.
  const [suiteTreeWidth, setSuiteTreeWidth] = useState<number>(280);
  const [queueGridWidth, setQueueGridWidth] = useState<number>(420);
  const [hoveredDivider, setHoveredDivider] = useState<"tree" | "queue" | null>(null);
  const [draggingPane, setDraggingPane] = useState<"tree" | "queue" | null>(null);

  const suiteTreeWidthRef = useRef(suiteTreeWidth);
  useEffect(() => {
    suiteTreeWidthRef.current = suiteTreeWidth;
  }, [suiteTreeWidth]);
  const queueGridWidthRef = useRef(queueGridWidth);
  useEffect(() => {
    queueGridWidthRef.current = queueGridWidth;
  }, [queueGridWidth]);

  const dragStateRef = useRef<{ pane: "tree" | "queue"; startX: number; startWidth: number } | null>(null);

  // Loosened per request (was 200-480 / 260-600 with Pane 3 >= 360): the two left panes can
  // now grow as far as the window allows, at the detail pane's expense. No fixed maximum --
  // the only cap is that Pane 3 keeps PANE3_MIN_WIDTH, recomputed on every drag tick.
  const SUITE_TREE_MIN = 140;
  const SUITE_TREE_MAX = Number.POSITIVE_INFINITY;
  const QUEUE_GRID_MIN = 180;
  const QUEUE_GRID_MAX = Number.POSITIVE_INFINITY;
  const PANE3_MIN_WIDTH = 160; // Pane 3 must always keep at least this much room

  // window-level listeners (added on mousedown, removed on mouseup) rather than an
  // onMouseMove handler on the divider itself -- a fast drag routinely outruns a 4px-wide
  // element, so only page-level tracking keeps up with the cursor for the whole drag.
  const handleDividerMouseMove = useCallback((e: MouseEvent) => {
    const drag = dragStateRef.current;
    if (!drag) return;
    const deltaX = e.clientX - drag.startX;
    if (drag.pane === "tree") {
      const max = Math.max(
        SUITE_TREE_MIN,
        Math.min(SUITE_TREE_MAX, window.innerWidth - PANE3_MIN_WIDTH - queueGridWidthRef.current),
      );
      setSuiteTreeWidth(Math.min(Math.max(drag.startWidth + deltaX, SUITE_TREE_MIN), max));
    } else {
      const max = Math.max(
        QUEUE_GRID_MIN,
        Math.min(QUEUE_GRID_MAX, window.innerWidth - PANE3_MIN_WIDTH - suiteTreeWidthRef.current),
      );
      setQueueGridWidth(Math.min(Math.max(drag.startWidth + deltaX, QUEUE_GRID_MIN), max));
    }
  }, []);

  const handleDividerMouseUp = useCallback(() => {
    dragStateRef.current = null;
    setDraggingPane(null);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    window.removeEventListener("mousemove", handleDividerMouseMove);
    window.removeEventListener("mouseup", handleDividerMouseUp);
  }, [handleDividerMouseMove]);

  const handleDividerMouseDown = useCallback(
    (pane: "tree" | "queue") => (e: React.MouseEvent) => {
      e.preventDefault();
      dragStateRef.current = {
        pane,
        startX: e.clientX,
        startWidth: pane === "tree" ? suiteTreeWidthRef.current : queueGridWidthRef.current,
      };
      setDraggingPane(pane);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", handleDividerMouseMove);
      window.addEventListener("mouseup", handleDividerMouseUp);
    },
    [handleDividerMouseMove, handleDividerMouseUp],
  );

  // Unmount safety net -- removeEventListener on an unregistered listener is a harmless
  // no-op, so this is safe to run even when no drag is in progress.
  useEffect(() => {
    return () => {
      window.removeEventListener("mousemove", handleDividerMouseMove);
      window.removeEventListener("mouseup", handleDividerMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [handleDividerMouseMove, handleDividerMouseUp]);

  const dividerStyle = (pane: "tree" | "queue"): React.CSSProperties => ({
    width: "4px",
    flexShrink: 0,
    cursor: "col-resize",
    backgroundColor: draggingPane === pane || hoveredDivider === pane ? "#3b82f6" : "#1f2937",
  });

  return { suiteTreeWidth, queueGridWidth, setHoveredDivider, handleDividerMouseDown, dividerStyle };
}
