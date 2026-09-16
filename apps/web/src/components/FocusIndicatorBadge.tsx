import React from 'react';
import { HotkeyStatus, FocusZone } from '../hooks/useFocusFSM';

export interface FocusIndicatorBadgeProps {
  status: HotkeyStatus;
  currentZone?: FocusZone;
  onToggleHotkeys?: () => void;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Visual Hotkey Status Badge Component (FocusIndicatorBadge)
 * Displays ACTIVE / TYPING MODE / READ ONLY / OFF state with color cues and tooltip details.
 * Ref: RFC 02 Section 6 (Visual Hotkey Toggle Indicator)
 */
export const FocusIndicatorBadge: React.FC<FocusIndicatorBadgeProps> = ({
  status,
  onToggleHotkeys,
  style,
}) => {
  let backgroundColor = '#16a34a';
  let textColor = '#ffffff';
  let borderColor = 'transparent';
  let subText = 'Single-key shortcuts active. Keystrokes log verdicts instantaneously.';

  switch (status) {
    case 'ACTIVE':
      backgroundColor = '#16a34a'; // Solid Green Pill
      textColor = '#ffffff';
      subText = 'Single-key shortcuts p, f, b, s, j, k active';
      break;

    case 'TYPING MODE':
      backgroundColor = '#d97706'; // Amber Pill
      textColor = '#ffffff';
      subText = 'Hotkeys auto-paused while typing. Press Ctrl+Enter to submit or Esc to re-engage.';
      break;

    case 'READ ONLY':
      backgroundColor = '#7f1d1d'; // Dark Red / Read Only
      textColor = '#fca5a5';
      borderColor = '#b91c1c';
      subText = 'You lack EXECUTE_RUN permission key. Verdict hotkeys disabled.';
      break;

    case 'OFF':
      backgroundColor = '#374151'; // Dark Gray Pill
      textColor = '#9ca3af';
      subText = 'Single-key hotkeys manually disabled.';
      break;
  }

  return (
    <div
      title={subText}
      onClick={onToggleHotkeys}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '4px 10px',
        borderRadius: '4px',
        backgroundColor,
        color: textColor,
        border: `1px solid ${borderColor}`,
        fontSize: '11px',
        fontWeight: 700,
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
        letterSpacing: '0.3px',
        cursor: onToggleHotkeys ? 'pointer' : 'default',
        userSelect: 'none',
        transition: 'all 0.15s ease-in-out',
        ...style,
      }}
    >
      <span>Hotkeys</span>
    </div>
  );
};
