import { useEffect, useCallback, RefObject } from 'react';
import { FocusFSMState } from './useFocusFSM';

export type VerdictType = 'PASSED' | 'FAILED' | 'BLOCKED' | 'SKIPPED';

export interface HotkeyEngineOptions {
  fsm: FocusFSMState;
  /** SPECIFICATION mode disables the verdict hotkeys (p/f/b/s) -- there's nothing to execute
   * there, only cases to browse and toggle in/out of the plan. Defaults to EXECUTION. */
  mode?: 'EXECUTION' | 'SPECIFICATION';
  caseCount: number;
  selectedIndex: number;
  onSelectIndex: (index: number) => void;
  onVerdict: (verdict: VerdictType, notes?: string) => void;
  onSubmitNotes?: (notes: string) => void;
  onToggleStepDrawer?: () => void;
  onToggleSuiteExpand?: (collapse?: boolean) => void;
  onFocusSearch?: () => void;
  onPermissionDeniedToast?: (message: string) => void;
  notesInputRef?: RefObject<HTMLTextAreaElement | HTMLInputElement | null>;
  targetTargetWindow?: Window;
}

/**
 * Pure Hotkey Event Handler Generator
 * Encapsulates full hotkey matrix logic: j, k, p, f, b, s, e, [, ], /, Esc, Ctrl+Enter.
 * Integrates Zone 4 input protection and RBAC permission guards.
 */
export function createHotkeyHandler(options: HotkeyEngineOptions) {
  const {
    fsm,
    mode = 'EXECUTION',
    caseCount,
    selectedIndex,
    onSelectIndex,
    onVerdict,
    onSubmitNotes,
    onToggleStepDrawer,
    onToggleSuiteExpand,
    onFocusSearch,
    onPermissionDeniedToast,
    notesInputRef,
  } = options;

  return function handleKeyDown(event: KeyboardEvent) {
    const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
    const isInput =
      activeEl &&
      (activeEl.tagName === 'INPUT' ||
        activeEl.tagName === 'TEXTAREA' ||
        activeEl.tagName === 'SELECT' ||
        (activeEl as HTMLElement).isContentEditable);

    // --- ZONE 4: INPUT & TYPING PROTECTION MODE ---
    if (isInput || fsm.currentZone === 'TEXT_INPUT') {
      // Ctrl+Enter or Cmd+Enter to submit verdict/notes from input
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        if (mode === 'SPECIFICATION') {
          onPermissionDeniedToast?.('Verdict hotkeys are unavailable in Specification mode');
          return;
        }
        if (!fsm.canExecute) {
          onPermissionDeniedToast?.('Permission Denied: EXECUTE_RUN required to submit execution');
          return;
        }
        if (!fsm.canOverwrite) {
          onPermissionDeniedToast?.('Permission Denied: EXECUTE_OVERWRITE required for completed executions');
          return;
        }
        if (onSubmitNotes && notesInputRef?.current) {
          onSubmitNotes(notesInputRef.current.value);
        } else {
          onVerdict('FAILED');
        }
        if (activeEl && typeof (activeEl as HTMLElement).blur === 'function') {
          (activeEl as HTMLElement).blur();
        }
        fsm.setZone('EXECUTION_CONTAINER');
        return;
      }

      // Esc key in input blurs focus and returns to EXECUTION_CONTAINER
      if (event.key === 'Escape') {
        event.preventDefault();
        if (activeEl && typeof (activeEl as HTMLElement).blur === 'function') {
          (activeEl as HTMLElement).blur();
        }
        fsm.setZone('EXECUTION_CONTAINER');
        return;
      }

      // All single-character hotkeys are AUTOMATICALLY DEACTIVATED while typing in input
      return;
    }

    // --- ZONE 5: MODAL DIALOG GUARD ---
    if (fsm.currentZone === 'MODAL') {
      if (event.key === 'Escape') {
        event.preventDefault();
        fsm.setZone('EXECUTION_CONTAINER');
      }
      return;
    }

    // If hotkeys are manually turned off or disabled
    if (fsm.hotkeyStatus === 'OFF') {
      return;
    }

    const key = event.key.toLowerCase();

    // --- GLOBAL SEARCH SHORTCUT ---
    if (key === '/') {
      event.preventDefault();
      onFocusSearch?.();
      fsm.setZone('TEXT_INPUT');
      return;
    }

    // --- TREE COLLAPSE / EXPAND ---
    if (key === '[') {
      event.preventDefault();
      onToggleSuiteExpand?.(true); // collapse
      return;
    }
    if (key === ']') {
      event.preventDefault();
      onToggleSuiteExpand?.(false); // expand
      return;
    }

    // --- NAVIGATION (j / k / Arrow keys) ---
    if (key === 'j' || event.key === 'ArrowDown') {
      event.preventDefault();
      if (caseCount > 0) {
        const nextIndex = Math.min(selectedIndex + 1, caseCount - 1);
        onSelectIndex(nextIndex);
      }
      return;
    }

    if (key === 'k' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (caseCount > 0) {
        const prevIndex = Math.max(selectedIndex - 1, 0);
        onSelectIndex(prevIndex);
      }
      return;
    }

    // --- STEP DRAWER TOGGLE (e) ---
    if (key === 'e') {
      event.preventDefault();
      onToggleStepDrawer?.();
      return;
    }

    // --- VERDICT HOTKEYS (p, f, b, s) WITH RBAC GUARDS ---
    if (key === 'p' || key === 'f' || key === 'b' || key === 's') {
      event.preventDefault();

      if (mode === 'SPECIFICATION') {
        onPermissionDeniedToast?.('Verdict hotkeys are unavailable in Specification mode');
        return;
      }

      // RBAC Permission Checks
      if (!fsm.canExecute) {
        onPermissionDeniedToast?.('Permission Denied: EXECUTE_RUN key required for verdict hotkeys');
        return;
      }
      if (!fsm.canOverwrite) {
        onPermissionDeniedToast?.('Permission Denied: EXECUTE_OVERWRITE key required for completed execution');
        return;
      }

      switch (key) {
        case 'p':
          // Rapid Pass: Log PASSED, auto-advance to next case
          onVerdict('PASSED');
          if (caseCount > 0 && selectedIndex < caseCount - 1) {
            onSelectIndex(selectedIndex + 1);
          }
          break;

        case 'f':
          // Fail: Log FAILED, focus notes textarea for Zone 4 entry
          onVerdict('FAILED');
          fsm.setZone('TEXT_INPUT');
          if (notesInputRef?.current) {
            setTimeout(() => {
              notesInputRef.current?.focus();
            }, 10);
          }
          break;

        case 'b':
          // Block: Log BLOCKED, focus notes / open defect input
          onVerdict('BLOCKED');
          fsm.setZone('TEXT_INPUT');
          if (notesInputRef?.current) {
            setTimeout(() => {
              notesInputRef.current?.focus();
            }, 10);
          }
          break;

        case 's':
          // Rapid Skip: Log SKIPPED, auto-advance to next case
          onVerdict('SKIPPED');
          if (caseCount > 0 && selectedIndex < caseCount - 1) {
            onSelectIndex(selectedIndex + 1);
          }
          break;
      }
    }
  };
}

/**
 * Global Hotkey Event Listener Hook (useHotkeyEngine)
 */
export function useHotkeyEngine(options: HotkeyEngineOptions) {
  const handler = useCallback(
    (event: KeyboardEvent) => {
      createHotkeyHandler(options)(event);
    },
    [
      options.fsm,
      options.mode,
      options.caseCount,
      options.selectedIndex,
      options.onSelectIndex,
      options.onVerdict,
      options.onSubmitNotes,
      options.onToggleStepDrawer,
      options.onToggleSuiteExpand,
      options.onFocusSearch,
      options.onPermissionDeniedToast,
      options.notesInputRef,
    ]
  );

  useEffect(() => {
    const win = options.targetTargetWindow || (typeof window !== 'undefined' ? window : null);
    if (!win) return;

    win.addEventListener('keydown', handler as any);
    return () => {
      win.removeEventListener('keydown', handler as any);
    };
  }, [handler, options.targetTargetWindow]);
}
