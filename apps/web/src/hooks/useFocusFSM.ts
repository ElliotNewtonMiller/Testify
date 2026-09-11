import { useState, useEffect, useCallback, useRef } from 'react';

export type FocusZone = 'TREE' | 'LIST' | 'EXECUTION_CONTAINER' | 'TEXT_INPUT' | 'MODAL';
export type HotkeyStatus = 'ACTIVE' | 'TYPING MODE' | 'READ ONLY' | 'OFF';

export interface FocusFSMOptions {
  initialZone?: FocusZone;
  permissions?: string[];
  isExecutionCompleted?: boolean;
  disabled?: boolean;
}

export interface FocusFSMState {
  currentZone: FocusZone;
  previousZone: FocusZone;
  hotkeyStatus: HotkeyStatus;
  isInputFocused: boolean;
  isReadOnly: boolean;
  canExecute: boolean;
  canOverwrite: boolean;
  setZone: (zone: FocusZone) => void;
  toggleHotkeys: () => void;
  checkInputFocus: () => boolean;
}

/**
 * Keyboard Focus State Machine (FSM) Hook
 * Manages 5 Focus Zones and auto-transitions hotkey states:
 * - Zone 1: TREE (Pane 1 Navigation)
 * - Zone 2: LIST (Pane 2 Test Case Queue)
 * - Zone 3: EXECUTION_CONTAINER (Pane 3 Execution - Hotkeys ACTIVE)
 * - Zone 4: TEXT_INPUT (Input/Textarea - Hotkeys AUTO-DEACTIVATED, TYPING MODE)
 * - Zone 5: MODAL (Modal Dialog)
 */
export function useFocusFSM(options: FocusFSMOptions = {}): FocusFSMState {
  const {
    initialZone = 'EXECUTION_CONTAINER',
    permissions = ['EXECUTE_RUN', 'EXECUTE_OVERWRITE'],
    isExecutionCompleted = false,
    disabled = false,
  } = options;

  const canExecute = permissions.includes('EXECUTE_RUN');
  const canOverwrite = !isExecutionCompleted || permissions.includes('EXECUTE_OVERWRITE');
  const isReadOnly = !canExecute || !canOverwrite;

  const [currentZone, setCurrentZoneState] = useState<FocusZone>(initialZone);
  const [previousZone, setPreviousZone] = useState<FocusZone>(initialZone);
  const [isInputFocused, setIsInputFocused] = useState<boolean>(false);
  const [isManuallyDisabled, setIsManuallyDisabled] = useState<boolean>(disabled);

  const currentZoneRef = useRef<FocusZone>(currentZone);
  const previousZoneRef = useRef<FocusZone>(previousZone);

  // Helper to check if an element is an input/form field
  const checkInputFocus = useCallback((): boolean => {
    if (typeof document === 'undefined') return false;
    const activeEl = document.activeElement;
    if (!activeEl) return false;

    const isInput =
      activeEl.tagName === 'INPUT' ||
      activeEl.tagName === 'TEXTAREA' ||
      activeEl.tagName === 'SELECT' ||
      (activeEl as HTMLElement).isContentEditable;

    return Boolean(isInput);
  }, []);

  // Zone Setter
  const setZone = useCallback(
    (newZone: FocusZone) => {
      if (newZone === currentZoneRef.current) return;
      previousZoneRef.current = currentZoneRef.current;
      setPreviousZone(currentZoneRef.current);
      currentZoneRef.current = newZone;
      setCurrentZoneState(newZone);
    },
    []
  );

  // Toggle Hotkeys On/Off
  const toggleHotkeys = useCallback(() => {
    setIsManuallyDisabled((prev) => !prev);
  }, []);

  // Sync window focusin/focusout to detect Zone 4 input typing automatically
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        setIsInputFocused(true);
        if (currentZoneRef.current !== 'TEXT_INPUT') {
          setZone('TEXT_INPUT');
        }
      }
    };

    const handleFocusOut = () => {
      setTimeout(() => {
        const inputActive = checkInputFocus();
        setIsInputFocused(inputActive);
        if (!inputActive && currentZoneRef.current === 'TEXT_INPUT') {
          // Re-engage previous zone (e.g. EXECUTION_CONTAINER)
          setZone(previousZoneRef.current || 'EXECUTION_CONTAINER');
        }
      }, 10);
    };

    window.addEventListener('focusin', handleFocusIn);
    window.addEventListener('focusout', handleFocusOut);

    return () => {
      window.removeEventListener('focusin', handleFocusIn);
      window.removeEventListener('focusout', handleFocusOut);
    };
  }, [checkInputFocus, setZone]);

  // Compute overall hotkey status string according to RFC 02 §6.1
  let hotkeyStatus: HotkeyStatus = 'ACTIVE';
  if (isManuallyDisabled) {
    hotkeyStatus = 'OFF';
  } else if (isReadOnly) {
    hotkeyStatus = 'READ ONLY';
  } else if (isInputFocused || currentZone === 'TEXT_INPUT') {
    hotkeyStatus = 'TYPING MODE';
  } else {
    hotkeyStatus = 'ACTIVE';
  }

  return {
    currentZone,
    previousZone,
    hotkeyStatus,
    isInputFocused,
    isReadOnly,
    canExecute,
    canOverwrite,
    setZone,
    toggleHotkeys,
    checkInputFocus,
  };
}
