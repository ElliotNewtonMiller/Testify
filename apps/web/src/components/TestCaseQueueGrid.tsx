import React, { useRef, useState, useEffect } from 'react';

export interface TestCaseGridItem {
  plan_case_id: string;
  case_id?: string;
  external_id: string;
  title: string;
  priority: string;
  execution_type?: string;
  version_number?: number;
  latest_verdict: 'UNTESTED' | 'PASSED' | 'FAILED' | 'BLOCKED' | 'SKIPPED';
}

export interface TestCaseQueueGridProps {
  cases: TestCaseGridItem[];
  selectedIndex: number;
  /** Index into `cases` (the already-filtered list App passes in); -1 when the active case
   * is hidden by the current search/filter, so no row is highlighted. */
  onSelectCase: (index: number) => void;
  containerHeight?: number;
}

const ROW_HEIGHT = 32; // Explicit 32px row height standard
const BUFFER_ITEMS = 10; // Virtualization buffer

/**
 * High-Density Data Grid Component (TestCaseQueueGrid)
 * Enforces 32px row height standard, 4px/8px minimal padding, high-contrast active outline,
 * colorblind-safe verdict badges (P, F, B, S, U), and virtualized scrolling for 5,000+ cases.
 * Ref: RFC 02 Section 3.1 & 3.2
 */
export const TestCaseQueueGrid: React.FC<TestCaseQueueGridProps> = ({
  cases,
  selectedIndex,
  onSelectCase,
  containerHeight,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [computedHeight, setComputedHeight] = useState(containerHeight || 500);

  // Measure container height dynamically if not provided
  useEffect(() => {
    if (containerHeight) {
      setComputedHeight(containerHeight);
      return;
    }
    const updateHeight = () => {
      if (containerRef.current) {
        setComputedHeight(containerRef.current.clientHeight || 500);
      }
    };
    updateHeight();
    window.addEventListener('resize', updateHeight);
    return () => window.removeEventListener('resize', updateHeight);
  }, [containerHeight]);

  // Search/filtering happens once in App.tsx (via the server's case-search route), which
  // passes the already-narrowed list here -- keeping indices in exactly one coordinate space.
  const filteredCases = cases;

  // Handle scroll for virtual windowing
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  };

  // Keep selected item visible in viewport when selectedIndex changes
  useEffect(() => {
    if (!containerRef.current || selectedIndex < 0) return;
    const targetScrollTop = selectedIndex * ROW_HEIGHT;
    const viewportHeight = computedHeight;
    const currentScrollTop = containerRef.current.scrollTop;

    if (targetScrollTop < currentScrollTop) {
      containerRef.current.scrollTop = targetScrollTop;
    } else if (targetScrollTop + ROW_HEIGHT > currentScrollTop + viewportHeight) {
      containerRef.current.scrollTop = targetScrollTop + ROW_HEIGHT - viewportHeight;
    }
  }, [selectedIndex, computedHeight]);

  // Calculate Virtual Window indices
  const totalCount = filteredCases.length;
  const totalHeight = totalCount * ROW_HEIGHT;

  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - BUFFER_ITEMS);
  const endIndex = Math.min(
    totalCount,
    Math.ceil((scrollTop + computedHeight) / ROW_HEIGHT) + BUFFER_ITEMS
  );

  const visibleCases = filteredCases.slice(startIndex, endIndex);
  const offsetY = startIndex * ROW_HEIGHT;

  // Render verdict badge helper with WCAG AAA colors (RFC 02 §8.1)
  const renderVerdictBadge = (verdict: TestCaseGridItem['latest_verdict']) => {
    let bg = '#111827';
    let fg = '#6b7280';
    let border = '#374151';
    let char = 'U';

    switch (verdict) {
      case 'PASSED':
        bg = '#052e16';
        fg = '#4ade80';
        border = '#22c55e';
        char = 'P';
        break;
      case 'FAILED':
        bg = '#450a0a';
        fg = '#f87171';
        border = '#ef4444';
        char = 'F';
        break;
      case 'BLOCKED':
        bg = '#451a03';
        fg = '#fbbf24';
        border = '#f59e0b';
        char = 'B';
        break;
      case 'SKIPPED':
        bg = '#1f2937';
        fg = '#9ca3af';
        border = '#6b7280';
        char = 'S';
        break;
      default:
        bg = '#111827';
        fg = '#6b7280';
        border = '#374151';
        char = 'U';
        break;
    }

    return (
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '20px',
          height: '20px',
          borderRadius: '3px',
          backgroundColor: bg,
          color: fg,
          border: `1px solid ${border}`,
          fontWeight: 700,
          fontSize: '11px',
          fontFamily: "'JetBrains Mono', monospace",
          flexShrink: 0,
        }}
      >
        {char}
      </span>
    );
  };

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      style={{
        flex: 1,
        width: '100%',
        height: '100%',
        overflowY: 'auto',
        backgroundColor: '#111827',
        position: 'relative',
        boxSizing: 'border-box',
      }}
    >
      <div style={{ height: `${totalHeight}px`, width: '100%', position: 'relative' }}>
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            transform: `translateY(${offsetY}px)`,
          }}
        >
          {visibleCases.map((c, idx) => {
            const actualIndex = startIndex + idx;
            const isSelected = actualIndex === selectedIndex;

            return (
              <div
                key={c.plan_case_id || `${c.external_id}-${actualIndex}`}
                onClick={() => onSelectCase(actualIndex)}
                style={{
                  height: `${ROW_HEIGHT}px`, // Strict 32px Height
                  boxSizing: 'border-box',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '4px 8px', // Minimal padding: 4px top/bottom, 8px left/right
                  borderBottom: '1px solid #1f2937',
                  backgroundColor: isSelected ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
                  borderLeft: isSelected ? '3px solid #3b82f6' : '3px solid transparent',
                  cursor: 'pointer',
                  fontSize: '12px',
                  userSelect: 'none',
                  transition: 'background-color 0.1s ease',
                }}
              >
                {/* Visual Verdict Badge */}
                {renderVerdictBadge(c.latest_verdict)}

                {/* External ID */}
                <span
                  style={{
                    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                    color: '#9ca3af',
                    fontSize: '11px',
                    width: '72px',
                    flexShrink: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {c.external_id}
                </span>

                {/* Case Title */}
                <span
                  style={{
                    flex: 1,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    color: isSelected ? '#ffffff' : '#d1d5db',
                    fontWeight: isSelected ? 600 : 400,
                  }}
                >
                  {c.title}
                </span>

                {/* Priority Badge */}
                {c.priority && (
                  <span
                    style={{
                      fontSize: '10px',
                      padding: '1px 4px',
                      borderRadius: '2px',
                      backgroundColor:
                        c.priority === 'HIGH' || c.priority === 'CRITICAL' || c.priority === 'P1'
                          ? 'rgba(239, 68, 68, 0.2)'
                          : 'rgba(107, 114, 128, 0.2)',
                      color:
                        c.priority === 'HIGH' || c.priority === 'CRITICAL' || c.priority === 'P1'
                          ? '#f87171'
                          : '#9ca3af',
                      fontWeight: 600,
                      flexShrink: 0,
                    }}
                  >
                    {c.priority}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
