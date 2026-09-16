import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useFocusFSM, FocusZone, FocusFSMState } from '../hooks/useFocusFSM';
import { createHotkeyHandler, VerdictType } from '../hooks/useHotkeyEngine';

describe('Keyboard Focus FSM & Hotkey Engine Tests', () => {
  let activeElementMock: any = null;

  beforeEach(() => {
    activeElementMock = null;

    // Mock document.activeElement safely
    if (typeof globalThis.document === 'undefined') {
      (globalThis as any).document = {};
    }
    Object.defineProperty(globalThis.document, 'activeElement', {
      get: () => activeElementMock,
      configurable: true,
    });
  });

  describe('Focus FSM State Machine logic', () => {
    it('computes correct initial state for EXECUTION_CONTAINER zone with permissions', () => {
      const permissions = ['EXECUTE_RUN', 'EXECUTE_OVERWRITE'];
      const canExecute = permissions.includes('EXECUTE_RUN');
      const canOverwrite = permissions.includes('EXECUTE_OVERWRITE');
      const isReadOnly = !canExecute || !canOverwrite;

      expect(canExecute).toBe(true);
      expect(isReadOnly).toBe(false);
    });

    it('identifies READ ONLY status when EXECUTE_RUN is missing', () => {
      const permissions = ['SPEC_VIEW']; // Missing EXECUTE_RUN
      const canExecute = permissions.includes('EXECUTE_RUN');
      const isReadOnly = !canExecute;

      expect(canExecute).toBe(false);
      expect(isReadOnly).toBe(true);
    });
  });

  describe('Global Hotkey Engine (createHotkeyHandler)', () => {
    function createMockFSM(overrides: Partial<FocusFSMState> = {}): FocusFSMState {
      return {
        currentZone: 'EXECUTION_CONTAINER',
        previousZone: 'EXECUTION_CONTAINER',
        hotkeyStatus: 'ACTIVE',
        isInputFocused: false,
        isReadOnly: false,
        canExecute: true,
        canOverwrite: true,
        setZone: vi.fn(),
        toggleHotkeys: vi.fn(),
        checkInputFocus: () => false,
        ...overrides,
      };
    }

    it('navigates list down with j and up with k', () => {
      const onSelectIndex = vi.fn();
      const fsm = createMockFSM();

      const handler = createHotkeyHandler({
        fsm,
        caseCount: 5,
        selectedIndex: 0,
        onSelectIndex,
        onVerdict: vi.fn(),
      });

      // Press 'j' -> Move to next case index 1
      handler({ key: 'j', preventDefault: vi.fn() } as any);
      expect(onSelectIndex).toHaveBeenCalledWith(1);

      // Press 'k' when at index 2 -> Move back to index 1
      const handler2 = createHotkeyHandler({
        fsm,
        caseCount: 5,
        selectedIndex: 2,
        onSelectIndex,
        onVerdict: vi.fn(),
      });

      handler2({ key: 'k', preventDefault: vi.fn() } as any);
      expect(onSelectIndex).toHaveBeenCalledWith(1);
    });

    it('executes rapid Pass (p) and Skip (s) with auto-advancing case index', () => {
      const onSelectIndex = vi.fn();
      const onVerdict = vi.fn();
      const fsm = createMockFSM();

      const handler = createHotkeyHandler({
        fsm,
        caseCount: 4,
        selectedIndex: 1,
        onSelectIndex,
        onVerdict,
      });

      // Press 'p' -> Log PASSED & auto-advance to index 2
      handler({ key: 'p', preventDefault: vi.fn() } as any);
      expect(onVerdict).toHaveBeenCalledWith('PASSED');
      expect(onSelectIndex).toHaveBeenCalledWith(2);

      // Press 's' -> Log SKIPPED & auto-advance to index 2
      handler({ key: 's', preventDefault: vi.fn() } as any);
      expect(onVerdict).toHaveBeenCalledWith('SKIPPED');
    });

    it('executes Fail (f) and Block (b) and shifts zone to TEXT_INPUT', () => {
      const onVerdict = vi.fn();
      const fsm = createMockFSM();

      const handler = createHotkeyHandler({
        fsm,
        caseCount: 3,
        selectedIndex: 0,
        onSelectIndex: vi.fn(),
        onVerdict,
      });

      // Press 'f' -> Log FAILED & setZone to TEXT_INPUT
      handler({ key: 'f', preventDefault: vi.fn() } as any);
      expect(onVerdict).toHaveBeenCalledWith('FAILED');
      expect(fsm.setZone).toHaveBeenCalledWith('TEXT_INPUT');

      // Press 'b' -> Log BLOCKED & setZone to TEXT_INPUT
      handler({ key: 'b', preventDefault: vi.fn() } as any);
      expect(onVerdict).toHaveBeenCalledWith('BLOCKED');
      expect(fsm.setZone).toHaveBeenCalledWith('TEXT_INPUT');
    });

    it('Zone 4 Auto-Pausing: prevents single-key shortcuts while typing in input', () => {
      const onVerdict = vi.fn();
      const onSelectIndex = vi.fn();
      const fsm = createMockFSM({ currentZone: 'TEXT_INPUT', hotkeyStatus: 'TYPING MODE' });

      // Simulate input active element
      activeElementMock = { tagName: 'TEXTAREA', blur: vi.fn() };

      const handler = createHotkeyHandler({
        fsm,
        caseCount: 3,
        selectedIndex: 0,
        onSelectIndex,
        onVerdict,
      });

      // Single-key shortcuts typed while in input -> MUST BE BYPASSED
      handler({ key: 'p', preventDefault: vi.fn() } as any);
      expect(onVerdict).not.toHaveBeenCalled();

      handler({ key: 'f', preventDefault: vi.fn() } as any);
      expect(onVerdict).not.toHaveBeenCalled();

      handler({ key: 'j', preventDefault: vi.fn() } as any);
      expect(onSelectIndex).not.toHaveBeenCalled();

      handler({ key: 'k', preventDefault: vi.fn() } as any);
      expect(onSelectIndex).not.toHaveBeenCalled();
    });

    it('Zone 4 Ctrl+Enter submits execution notes from input', () => {
      const onSubmitNotes = vi.fn();
      const fsm = createMockFSM({ currentZone: 'TEXT_INPUT', hotkeyStatus: 'TYPING MODE' });

      const mockTextarea = { tagName: 'TEXTAREA', value: 'OAuth PKCE validation error', blur: vi.fn() };
      activeElementMock = mockTextarea;

      const handler = createHotkeyHandler({
        fsm,
        caseCount: 3,
        selectedIndex: 0,
        onSelectIndex: vi.fn(),
        onVerdict: vi.fn(),
        onSubmitNotes,
        notesInputRef: { current: mockTextarea as any },
      });

      // Press Ctrl+Enter -> Submits notes & sets zone back to EXECUTION_CONTAINER
      handler({
        key: 'Enter',
        ctrlKey: true,
        preventDefault: vi.fn(),
      } as any);

      expect(onSubmitNotes).toHaveBeenCalledWith('OAuth PKCE validation error');
      expect(fsm.setZone).toHaveBeenCalledWith('EXECUTION_CONTAINER');
      expect(mockTextarea.blur).toHaveBeenCalled();
    });

    it('RBAC Guard: blocks verdict hotkeys and emits permission warning when EXECUTE_RUN is missing', () => {
      const onVerdict = vi.fn();
      const onPermissionDeniedToast = vi.fn();
      const fsm = createMockFSM({
        canExecute: false, // Permission DENIED
        isReadOnly: true,
        hotkeyStatus: 'READ ONLY',
      });

      const handler = createHotkeyHandler({
        fsm,
        caseCount: 3,
        selectedIndex: 0,
        onSelectIndex: vi.fn(),
        onVerdict,
        onPermissionDeniedToast,
      });

      // Press 'p' without permission -> Blocked with toast
      handler({ key: 'p', preventDefault: vi.fn() } as any);
      expect(onVerdict).not.toHaveBeenCalled();
      expect(onPermissionDeniedToast).toHaveBeenCalledWith(
        expect.stringContaining('EXECUTE_RUN')
      );
    });

    it('Esc key in Zone 4 blurs input and returns focus state to EXECUTION_CONTAINER', () => {
      const fsm = createMockFSM({ currentZone: 'TEXT_INPUT', hotkeyStatus: 'TYPING MODE' });
      const mockInput = { tagName: 'INPUT', blur: vi.fn() };
      activeElementMock = mockInput;

      const handler = createHotkeyHandler({
        fsm,
        caseCount: 3,
        selectedIndex: 0,
        onSelectIndex: vi.fn(),
        onVerdict: vi.fn(),
      });

      // Press Esc in input -> Blurs input & sets zone back to EXECUTION_CONTAINER
      handler({ key: 'Escape', preventDefault: vi.fn() } as any);
      expect(mockInput.blur).toHaveBeenCalled();
      expect(fsm.setZone).toHaveBeenCalledWith('EXECUTION_CONTAINER');
    });

    it('Global search shortcut (/) triggers search focus callback and sets TEXT_INPUT zone', () => {
      const onFocusSearch = vi.fn();
      const fsm = createMockFSM();

      const handler = createHotkeyHandler({
        fsm,
        caseCount: 3,
        selectedIndex: 0,
        onSelectIndex: vi.fn(),
        onVerdict: vi.fn(),
        onFocusSearch,
      });

      handler({ key: '/', preventDefault: vi.fn() } as any);
      expect(onFocusSearch).toHaveBeenCalled();
      expect(fsm.setZone).toHaveBeenCalledWith('TEXT_INPUT');
    });

    it('Specification mode: verdict hotkeys (p/f/b/s) are disabled with a toast, even with full permissions', () => {
      const onVerdict = vi.fn();
      const onPermissionDeniedToast = vi.fn();
      const fsm = createMockFSM(); // canExecute/canOverwrite both true

      const handler = createHotkeyHandler({
        fsm,
        mode: 'SPECIFICATION',
        caseCount: 5,
        selectedIndex: 0,
        onSelectIndex: vi.fn(),
        onVerdict,
        onPermissionDeniedToast,
      });

      for (const key of ['p', 'f', 'b', 's']) {
        handler({ key, preventDefault: vi.fn() } as any);
      }

      expect(onVerdict).not.toHaveBeenCalled();
      expect(onPermissionDeniedToast).toHaveBeenCalledWith(
        expect.stringContaining('Specification mode')
      );
    });

    it('Specification mode: Ctrl+Enter submit is also disabled with a toast', () => {
      const onSubmitNotes = vi.fn();
      const onPermissionDeniedToast = vi.fn();
      const fsm = createMockFSM({ currentZone: 'TEXT_INPUT', hotkeyStatus: 'TYPING MODE' });
      const mockTextarea = { tagName: 'TEXTAREA', value: 'irrelevant', blur: vi.fn() };
      activeElementMock = mockTextarea;

      const handler = createHotkeyHandler({
        fsm,
        mode: 'SPECIFICATION',
        caseCount: 3,
        selectedIndex: 0,
        onSelectIndex: vi.fn(),
        onVerdict: vi.fn(),
        onSubmitNotes,
        onPermissionDeniedToast,
        notesInputRef: { current: mockTextarea as any },
      });

      handler({ key: 'Enter', ctrlKey: true, preventDefault: vi.fn() } as any);
      expect(onSubmitNotes).not.toHaveBeenCalled();
      expect(onPermissionDeniedToast).toHaveBeenCalledWith(
        expect.stringContaining('Specification mode')
      );
    });

    it('Specification mode: navigation (j/k) still works -- only verdict recording is disabled', () => {
      const onSelectIndex = vi.fn();
      const fsm = createMockFSM();

      const handler = createHotkeyHandler({
        fsm,
        mode: 'SPECIFICATION',
        caseCount: 5,
        selectedIndex: 1,
        onSelectIndex,
        onVerdict: vi.fn(),
      });

      handler({ key: 'j', preventDefault: vi.fn() } as any);
      expect(onSelectIndex).toHaveBeenCalledWith(2);
    });

    it('Bracket shortcuts ([ and ]) trigger tree collapse and expand callbacks', () => {
      const onToggleSuiteExpand = vi.fn();
      const fsm = createMockFSM();

      const handler = createHotkeyHandler({
        fsm,
        caseCount: 3,
        selectedIndex: 0,
        onSelectIndex: vi.fn(),
        onVerdict: vi.fn(),
        onToggleSuiteExpand,
      });

      // Press '[' -> Collapse
      handler({ key: '[', preventDefault: vi.fn() } as any);
      expect(onToggleSuiteExpand).toHaveBeenCalledWith(true);

      // Press ']' -> Expand
      handler({ key: ']', preventDefault: vi.fn() } as any);
      expect(onToggleSuiteExpand).toHaveBeenCalledWith(false);
    });
  });
});
