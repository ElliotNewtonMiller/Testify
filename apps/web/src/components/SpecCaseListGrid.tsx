import React, { useRef, useState, useEffect } from 'react';

export interface SpecCaseGridItem {
  id: string; // test_case_id
  external_id: string;
  title: string;
  priority: string;
  execution_type?: string;
  test_suite_id: string;
  latest_version: { id: string; version_number: number; status: string } | null;
  in_plan: boolean;
  test_plan_case_id: string | null;
  linkable: boolean;
}

export interface SpecCaseListGridProps {
  cases: SpecCaseGridItem[];
  selectedCaseId: string | null;
  /** `mods` carries Shift (range) / Ctrl-Cmd (toggle) for multi-select. */
  onSelectCase: (caseId: string, mods?: { shift: boolean; toggle: boolean }) => void;
  /** Extra cases highlighted as selected (multi-select), on top of selectedCaseId. */
  selectedCaseIds?: Set<string>;
  /** Drag-and-drop moving: rows are draggable when canDrag. */
  canDrag?: boolean;
  onDragStartCase?: (caseId: string, e: React.DragEvent) => void;
  onDragEndItems?: () => void;
  /** Whether the current user holds PLAN_MANAGE -- gates the include/exclude button. */
  canManagePlan: boolean;
  onToggleInclusion: (testCaseId: string, include: boolean) => void;
  /** test_case_id of a toggle currently in flight, shown with a subdued/disabled state. */
  pendingCaseId?: string | null;
  /** The case to keep scrolled into view (the one shown in the details pane). */
  scrollToCaseId?: string | null;
  containerHeight?: number;
}

const ROW_HEIGHT = 38; // Was 32 (TestCaseQueueGrid's row density standard) -- grown a bit to
// give the plan-inclusion toggle button below more vertical padding, so it's easier to click.
const BUFFER_ITEMS = 10;

// A solid fill color per version status -- the badge itself is now just a small colored box
// (see renderVersionBadge below), so only one color per status is needed rather than a
// bg/fg/border triple.
const VERSION_STATUS_COLORS: Record<string, string> = {
  DRAFT: '#9ca3af',
  APPROVED: '#22c55e',
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
  selectedCaseIds,
  canDrag = false,
  onDragStartCase,
  onDragEndItems,
  canManagePlan,
  onToggleInclusion,
  pendingCaseId = null,
  scrollToCaseId = null,
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

  // Search/filtering happens once in App.tsx (via the server's case-search route), which
  // passes the already-narrowed list here.
  const filteredCases = cases;

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  };

  // Keep the shown case visible when it changes (e.g. moving with j/k), like TestCaseQueueGrid.
  const scrollToIndex = scrollToCaseId ? filteredCases.findIndex((c) => c.id === scrollToCaseId) : -1;
  useEffect(() => {
    if (!containerRef.current || scrollToIndex < 0) return;
    const targetScrollTop = scrollToIndex * ROW_HEIGHT;
    const currentScrollTop = containerRef.current.scrollTop;
    if (targetScrollTop < currentScrollTop) {
      containerRef.current.scrollTop = targetScrollTop;
    } else if (targetScrollTop + ROW_HEIGHT > currentScrollTop + computedHeight) {
      containerRef.current.scrollTop = targetScrollTop + ROW_HEIGHT - computedHeight;
    }
  }, [scrollToIndex, computedHeight]);

  const totalCount = filteredCases.length;
  const totalHeight = totalCount * ROW_HEIGHT;

  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - BUFFER_ITEMS);
  const endIndex = Math.min(
    totalCount,
    Math.ceil((scrollTop + computedHeight) / ROW_HEIGHT) + BUFFER_ITEMS
  );

  const visibleCases = filteredCases.slice(startIndex, endIndex);
  const offsetY = startIndex * ROW_HEIGHT;

  // Space-efficient status indicator: a small solid-colored box (green = approved, grey =
  // draft, etc.) instead of a wide text badge -- the status is still available on hover via
  // the title tooltip, and the ~54px this frees up goes straight to the title column.
  const renderVersionBadge = (item: SpecCaseGridItem) => {
    if (!item.latest_version) {
      return (
        <span
          title="No version"
          style={{ width: '10px', height: '10px', borderRadius: '2px', border: '1px solid #374151', boxSizing: 'border-box', flexShrink: 0 }}
        />
      );
    }
    // Deprecated cases (only listed when "Show deprecated" is on) get no box at all -- an
    // invisible same-size placeholder keeps the id/title columns aligned with other rows.
    if (item.latest_version.status === 'DEPRECATED') {
      return (
        <span
          title={`v${item.latest_version.version_number} DEPRECATED`}
          style={{ width: '10px', height: '10px', flexShrink: 0 }}
        />
      );
    }
    const color = VERSION_STATUS_COLORS[item.latest_version.status] || VERSION_STATUS_COLORS.DRAFT;
    // DRAFT is an outline rather than a fill so it reads clearly apart from APPROVED's solid
    // green at a glance. Brighter grey than the dim "no version" outline above.
    const isDraft = item.latest_version.status === 'DRAFT' || !VERSION_STATUS_COLORS[item.latest_version.status];
    return (
      <span
        title={`v${item.latest_version.version_number} ${item.latest_version.status}`}
        style={{
          width: '10px',
          height: '10px',
          borderRadius: '2px',
          boxSizing: 'border-box',
          flexShrink: 0,
          ...(isDraft ? { border: `1.5px solid ${color}` } : { backgroundColor: color }),
        }}
      />
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
            const isSelected = c.id === selectedCaseId || Boolean(selectedCaseIds?.has(c.id));
            const isDeprecated = c.latest_version?.status === 'DEPRECATED';
            return (
              <div
                key={c.id || `${c.external_id}-${startIndex + idx}`}
                onClick={(e) => onSelectCase(c.id, { shift: e.shiftKey, toggle: e.ctrlKey || e.metaKey })}
                draggable={canDrag}
                onDragStart={canDrag ? (e) => onDragStartCase?.(c.id, e) : undefined}
                onDragEnd={canDrag ? () => onDragEndItems?.() : undefined}
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
                  opacity: isDeprecated ? 0.5 : 1,
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
