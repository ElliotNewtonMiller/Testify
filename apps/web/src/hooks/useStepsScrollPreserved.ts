import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type React from "react";

type StepsScrollRestoreMode = "restore" | "scrollToBottom";

/**
 * Shared scroll-preservation primitives for the Spec-mode step editor (see
 * specDetailScrollRef). Reordering/removing/adding a step mutates DOM nodes inside that
 * scroll container, and React's commit-phase focus/selection restoration (restoreSelection)
 * engages whenever a mutation touches a subtree containing the currently-focused node,
 * re-applying a snapshotted scroll offset that can land wrong -- captureScroll/
 * blurActiveElement/scheduleRestore give every mutation site the same, consistent discipline
 * (capture the position worth keeping -> blur so restoreSelection has nothing to misapply ->
 * mutate -> schedule the correction) instead of four independently hand-rolled variants, which
 * is exactly how one of the four (addStep) ended up missing the blur step in an earlier pass.
 * scheduleRestore's correction runs in a useLayoutEffect -- synchronously after the DOM
 * mutation/any restoreSelection adjustment but strictly before the browser paints -- so it's
 * always the last word before the user sees a frame, never a later, visibly-corrective jump.
 */
export function useStepsScrollPreserved(
  scrollRef: React.RefObject<HTMLDivElement>,
  endAnchorRef?: React.RefObject<HTMLDivElement>,
) {
  const preservedTopRef = useRef<number | null>(null);
  const pendingModeRef = useRef<StepsScrollRestoreMode | null>(null);
  const [restoreTick, setRestoreTick] = useState(0);

  const captureScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) preservedTopRef.current = el.scrollTop;
  }, [scrollRef]);

  const blurActiveElement = useCallback(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  }, []);

  // "restore" re-applies the position captureScroll last saw (right for a reorder/removal,
  // which shouldn't move the viewport at all); "scrollToBottom" ignores the captured value and
  // scrolls to the new bottom instead (right for an append, where the previous scrollTop would
  // now fall short of the true bottom by one row's height and leave the new row off-screen).
  const scheduleRestore = useCallback((mode: StepsScrollRestoreMode) => {
    pendingModeRef.current = mode;
    setRestoreTick((t) => t + 1);
  }, []);

  useLayoutEffect(() => {
    const mode = pendingModeRef.current;
    if (mode === null) return;
    pendingModeRef.current = null;
    const el = scrollRef.current;
    if (!el) return;
    if (mode === "scrollToBottom") {
      // Content (custom fields) now sits BELOW the step list, so the container's own bottom
      // is no longer the steps' bottom -- scroll just far enough to bring the end-of-steps
      // anchor into view (never upward), falling back to the true bottom without an anchor.
      const anchor = endAnchorRef?.current;
      if (anchor) {
        const delta = anchor.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom;
        if (delta > 0) el.scrollTop += delta;
      } else {
        el.scrollTop = el.scrollHeight;
      }
      // Keep the captured position in sync with where an append just scrolled to -- the
      // in-flight autosave triggered by the blur that preceded this add later schedules a
      // "restore", which would otherwise snap back to the pre-append scrollTop it captured.
      preservedTopRef.current = el.scrollTop;
    } else if (preservedTopRef.current !== null) {
      el.scrollTop = preservedTopRef.current;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoreTick]);

  return { captureScroll, blurActiveElement, scheduleRestore };
}
