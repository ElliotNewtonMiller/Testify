import React, { useRef, useState, useEffect, useMemo } from 'react';

export interface SpecCaseGridItem {
  id: string; // test_case_id
  external_id: string;
  title: string;
  priority: string;
  execution_type?: string;
  test_suite_id: string;
  latest_version: { id: string; version_number: number; status: string } | null;
  in_plan: boolean;
  plan_case_id: string | null;
  linkable: boolean;
}

export interface SpecCaseListGridProps {
  cases: SpecCaseGridItem[];
  selectedCaseId: string | null;
  onSelectCase: (caseId: string) => void;
  filterQuery?: string;
  /** Whether the current user holds PLAN_MANAGE -- gates the include/exclude button. */
  canManagePlan: boolean;
  onToggleInclusion: (testCaseId: string, include: boolean) => void;
  /** test_case_id of a toggle currently in flight, shown with a subdued/disabled state. */
  pendingCaseId?: string | null;
  containerHeight?: number;
}

const ROW_HEIGHT = 38; // Was 32 (TestCaseQueueGrid's row density standard) -- grown a bit to
// give the plan-inclusion toggle button below more vertical padding, so it's easier to click.
const BUFFER_ITEMS = 10;

const VERSION_STATUS_STYLES: Record<string, { bg: string; fg: string; border: string }> = {
  DRAFT: { bg: '#1f2937', fg: '#9ca3af', border: '#374151' },
  IN_REVIEW: { bg: '#1e3a5f', fg: '#60a5fa', border: '#2563eb' },
  APPROVED: { bg: '#052e16', fg: '#4ade80', border: '#22c55e' },
  DEPRECATED: { bg: '#450a0a', fg: '#f87171', border: '#ef4444' },
};

/**
 * Specification-mode case list: read-only status/version badges + a per-case plan
 * inclusion toggle, replacing TestCaseQueueGrid's verdict badge + click-to-execute
 * interaction. Kept as a sibling component rather than a mode flag on TestCaseQueueGrid
 * since the payload shape and interaction model genuinely diverge (no verdicts here).
 */
export const SpecCaseListGrid: React.FC<SpecCaseListGridProps> = ({
  cases,
  selectedCaseId,
  onSelectCase,
  filterQuery = '',
  canManagePlan,
  onToggleInclusion,
  pendingCaseId = null,
  containerHeight,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [computedHeight, setComputedHeight] = useState(containerHeight || 500);

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

  const filteredCases = useMemo(() => {
    if (!filterQuery.trim()) return cases;
    const q = filterQuery.toLowerCase();
    return cases.filter(
      (c) => c.external_id.toLowerCase().includes(q) || c.title.toLowerCase().includes(q)
    );
  }, [cases, filterQuery]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  };

  const totalCount = filteredCases.length;
  const totalHeight = totalCount * ROW_HEIGHT;

  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - BUFFER_ITEMS);
  const endIndex = Math.min(
    totalCount,
    Math.ceil((scrollTop + computedHeight) / ROW_HEIGHT) + BUFFER_ITEMS
  );

  const visibleCases = filteredCases.slice(startIndex, endIndex);
  const offsetY = startIndex * ROW_HEIGHT;

  const renderVersionBadge = (item: SpecCaseGridItem) => {
    if (!item.latest_version) {
      return (
        <span style={{ fontSize: '10px', color: '#6b7280', width: '64px', flexShrink: 0 }}>NO VERSION</span>
      );
    }
    const style = VERSION_STATUS_STYLES[item.latest_version.status] || VERSION_STATUS_STYLES.DRAFT;
    return (
      <span
        title={`v${item.latest_version.version_number} ${item.latest_version.status}`}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '1px 5px',
          borderRadius: '3px',
          backgroundColor: style.bg,
          color: style.fg,
          border: `1px solid ${style.border}`,
          fontWeight: 700,
          fontSize: '9px',
          flexShrink: 0,
          width: '64px',
          textAlign: 'center',
        }}
      >
        {item.latest_version.status}
      </span>
    );
  };

  const renderToggleButton = (item: SpecCaseGridItem) => {
    const isPending = pendingCaseId === item.id;
    const disabled = isPending || !canManagePlan || (!item.in_plan && !item.linkable);

    let title = item.in_plan ? 'Remove from plan' : 'Add to plan';
    if (!canManagePlan) title = 'Requires plan management permission';
    else if (!item.in_plan && !item.linkable) {
      title = 'Latest version is not Approved -- this project does not allow linking draft versions to a plan';
    }

    return (
      <button
        onClick={(e) => {
          e.stopPropagation();
          if (disabled) return;
          onToggleInclusion(item.id, !item.in_plan);
        }}
        disabled={disabled}
        title={title}
        style={{
          flexShrink: 0,
          padding: '7px 10px',
          borderRadius: '4px',
          fontSize: '10px',
          fontWeight: 700,
          border: item.in_plan ? '1px solid #22c55e' : '1px solid #334155',
          backgroundColor: item.in_plan ? 'rgba(34, 197, 94, 0.15)' : 'transparent',
          color: item.in_plan ? '#4ade80' : disabled ? '#4b5563' : '#9ca3af',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: isPending ? 0.5 : 1,
        }}
      >
        {isPending ? '…' : item.in_plan ? '✓ In Plan' : '+ Add'}
      </button>
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
            const isSelected = c.id === selectedCaseId;
            return (
              <div
                key={c.id || `${c.external_id}-${startIndex + idx}`}
                onClick={() => onSelectCase(c.id)}
                style={{
                  height: `${ROW_HEIGHT}px`,
                  boxSizing: 'border-box',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '4px 8px',
                  borderBottom: '1px solid #1f2937',
                  backgroundColor: isSelected ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
                  borderLeft: isSelected ? '3px solid #3b82f6' : '3px solid transparent',
                  cursor: 'pointer',
                  fontSize: '12px',
                  userSelect: 'none',
                  transition: 'background-color 0.1s ease',
                }}
              >
                {renderVersionBadge(c)}

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

                {renderToggleButton(c)}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
