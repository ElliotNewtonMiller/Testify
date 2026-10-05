import React, { useState, useCallback } from 'react';

export interface SuiteTreeNode {
  id: string;
  name: string;
  path: string;
  parentId?: string | null;
  children?: SuiteTreeNode[];
  passedCount?: number;
  totalCount?: number;
  isExpanded?: boolean;
  /** Specification-mode plan-inclusion counts, summed recursively over the subtree
   * (from GET /api/v1/projects/:id/spec-tree). Drive the tri-state cascade indicator. */
  inPlanCount?: number;
  totalCaseCount?: number;
}

export interface VirtualizedSuiteTreeProps {
  suites: SuiteTreeNode[];
  selectedSuiteId?: string | null;
  /** The suite containing whichever test case is currently focused for execution (the
   * Queue Grid's active row) -- distinct from selectedSuiteId, which is click-driven and
   * used for Specification-mode filtering/curation. Purely a visual "you are here" cue in
   * Execution mode; doesn't affect selection, filtering, or click behavior. */
  activeSuiteId?: string | null;
  onSelectSuite?: (suiteId: string) => void;
  onToggleExpand?: (suiteId: string, expanded: boolean) => void;
  /** EXECUTION (default) shows the pass/fail progress pill; SPECIFICATION shows the
   * plan-inclusion tri-state indicator instead. */
  mode?: 'EXECUTION' | 'SPECIFICATION';
  /** Whether the current user holds PLAN_MANAGE -- gates the inclusion indicator's click
   * handler (view-only otherwise, matching how execute buttons are disabled elsewhere). */
  canManagePlan?: boolean;
  /** Fired when a suite's inclusion indicator is clicked in Specification mode. */
  onToggleSuiteInclusion?: (suiteId: string, action: 'ADD' | 'REMOVE') => void;
  /** Whether the current user holds SPEC_CREATE/SPEC_EDIT/SPEC_DELETE -- gates the new
   * create-child/rename/delete icon buttons in Specification mode. */
  canCreateSuites?: boolean;
  canEditSuites?: boolean;
  canDeleteSuites?: boolean;
  /** Fired when a suite's "+" (create child suite) affordance is clicked. */
  onCreateChildSuite?: (parentSuiteId: string) => void;
  /** Fired when a suite's rename affordance is clicked. */
  onRenameSuite?: (suiteId: string, currentName: string, currentParentId: string | null) => void;
  /** Fired when a suite's delete affordance is clicked. */
  onDeleteSuite?: (suiteId: string) => void;
}

const TREE_ROW_HEIGHT = 28; // Explicit 28px tree node standard (RFC 02 §3.1)
const INDENT_PER_LEVEL = 12; // 12px indentation per level

/**
 * High-Density Node Tree Navigation Component (VirtualizedSuiteTree)
 * Enforces 28px node height standard, 12px per level indentation, 16px icons,
 * expand/collapse folder toggles, progress pills (e.g. 12/15 P).
 * Ref: RFC 02 Section 3.1
 */
export const VirtualizedSuiteTree: React.FC<VirtualizedSuiteTreeProps> = ({
  suites,
  selectedSuiteId,
  activeSuiteId,
  onSelectSuite,
  onToggleExpand,
  mode = 'EXECUTION',
  canManagePlan = false,
  onToggleSuiteInclusion,
  canCreateSuites = false,
  canEditSuites = false,
  canDeleteSuites = false,
  onCreateChildSuite,
  onRenameSuite,
  onDeleteSuite,
}) => {
  const [expandedMap, setExpandedMap] = useState<Record<string, boolean>>({});

  // Flips whatever the arrow currently shows. The caller passes that state in because a suite
  // with no entry in expandedMap is displayed expanded by default -- computing the next state
  // as `!prev[suiteId]` (undefined -> true) used to "expand" an already-expanded suite, so the
  // first click on every arrow after a reload did nothing.
  const toggleSuite = useCallback(
    (suiteId: string, currentlyExpanded: boolean, e?: React.MouseEvent) => {
      if (e) e.stopPropagation();
      const nextState = !currentlyExpanded;
      setExpandedMap((prev) => ({ ...prev, [suiteId]: nextState }));
      onToggleExpand?.(suiteId, nextState);
    },
    [onToggleExpand]
  );

  // Flatten recursive tree nodes into visual items with depth level
  const flattenTree = useCallback(
    (nodes: SuiteTreeNode[], depth = 0): Array<{ node: SuiteTreeNode; depth: number }> => {
      let result: Array<{ node: SuiteTreeNode; depth: number }> = [];

      for (const node of nodes) {
        result.push({ node, depth });

        const isExpanded = expandedMap[node.id] ?? node.isExpanded ?? true;
        if (isExpanded && node.children && node.children.length > 0) {
          result = result.concat(flattenTree(node.children, depth + 1));
        }
      }

      return result;
    },
    [expandedMap]
  );

  const flatNodes = flattenTree(suites);

  const renderInclusionIndicator = (node: SuiteTreeNode) => {
    const total = node.totalCaseCount ?? 0;
    const inPlan = node.inPlanCount ?? 0;
    if (total === 0) return null;

    const state: 'all' | 'partial' | 'none' = inPlan === 0 ? 'none' : inPlan === total ? 'all' : 'partial';
    // Partial always escalates to fully-on first, same as a standard tri-state checkbox.
    const nextAction: 'ADD' | 'REMOVE' = state === 'all' ? 'REMOVE' : 'ADD';

    const bg = state === 'all' ? '#15803d' : state === 'partial' ? '#b45309' : 'transparent';
    const border = state === 'all' ? '#22c55e' : state === 'partial' ? '#f59e0b' : '#4b5563';
    const symbol = state === 'all' ? '✓' : state === 'partial' ? '–' : '';

    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', flexShrink: 0, marginLeft: '8px' }}>
        <span style={{ fontSize: '10px', color: '#9ca3af' }}>
          {inPlan}/{total}
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (!canManagePlan) return;
            onToggleSuiteInclusion?.(node.id, nextAction);
          }}
          disabled={!canManagePlan}
          title={
            canManagePlan
              ? `${inPlan}/${total} in plan -- click to ${nextAction === 'ADD' ? 'add all' : 'remove all'}`
              : 'Requires plan management permission'
          }
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '16px',
            height: '16px',
            borderRadius: '3px',
            backgroundColor: bg,
            border: `1px solid ${border}`,
            color: '#ffffff',
            fontSize: '10px',
            fontWeight: 700,
            cursor: canManagePlan ? 'pointer' : 'not-allowed',
            opacity: canManagePlan ? 1 : 0.5,
            padding: 0,
          }}
        >
          {symbol}
        </button>
      </span>
    );
  };

  return (
    <div
      style={{
        flex: 1,
        width: '100%',
        height: '100%',
        // Both axes: a name/subtree too wide for the pane now gets a horizontal scrollbar
        // instead of truncating/reflowing (see the row styling below) -- per direct request,
        // resizing this pane should never move where a suite's row content sits.
        overflow: 'auto',
        backgroundColor: '#0d111c',
        boxSizing: 'border-box',
      }}
    >
      {/* Sized to the widest row's natural (unwrapped) content, but never smaller than the
          visible pane (minWidth: 100%). This is what makes every row's own box -- even a
          short-named sibling -- span the full scrollable width, which the sticky "always
          visible" action buttons below need in order to clamp correctly to the pane's right
          edge at any scroll position, not just when scrolled all the way right. */}
      <div style={{ width: 'fit-content', minWidth: '100%' }}>
        {flatNodes.map(({ node, depth }) => {
          const isSelected = node.id === selectedSuiteId;
          const isActive = !isSelected && Boolean(activeSuiteId) && node.id === activeSuiteId;
          const hasChildren = Boolean(node.children && node.children.length > 0);
          const isExpanded = expandedMap[node.id] ?? node.isExpanded ?? true;

          const indentPx = depth * INDENT_PER_LEVEL + 8;
          const passed = node.passedCount ?? 0;
          const total = node.totalCount ?? 0;

          return (
            <div
              key={node.id}
              onClick={() => onSelectSuite?.(node.id)}
              style={{
                height: `${TREE_ROW_HEIGHT}px`, // Strict 28px Tree Node Row Standard
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                paddingLeft: `${indentPx}px`,
                backgroundColor: isSelected
                  ? 'rgba(59, 130, 246, 0.18)'
                  : isActive
                    ? 'rgba(34, 211, 238, 0.12)'
                    : 'transparent',
                borderLeft: isSelected ? '3px solid #3b82f6' : isActive ? '3px solid #22d3ee' : '3px solid transparent',
                borderRadius: '2px',
                fontSize: '12px',
                color: isSelected || isActive ? '#ffffff' : '#d1d5db',
                cursor: 'pointer',
                userSelect: 'none',
                transition: 'background-color 0.1s ease',
              }}
            >
              {/* Folder Toggle Icon + Title -- never shrinks or truncates (flexShrink: 0,
                  no ellipsis/overflow-hidden): a name too long to fit widens the row instead,
                  same reasoning as the outer container's overflow: auto above. */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                {hasChildren ? (
                  <span
                    onClick={(e) => toggleSuite(node.id, isExpanded, e)}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: '16px',
                      height: '16px',
                      // Bigger click target, same look: 6px of padding grows the hit area to
                      // 28x28 (the full row height), and the matching -6px margin cancels it
                      // out of the layout, so nothing moves. It reaches into the row's indent
                      // on the left and the 6px gap before the folder icon on the right.
                      boxSizing: 'content-box',
                      padding: '6px',
                      margin: '-6px',
                      fontSize: '10px',
                      color: '#9ca3af',
                      cursor: 'pointer',
                      userSelect: 'none',
                    }}
                  >
                    {isExpanded ? '▼' : '▶'}
                  </span>
                ) : (
                  <span style={{ width: '16px', height: '16px', display: 'inline-block' }} />
                )}

                <span style={{ fontSize: '14px', flexShrink: 0 }}>📁</span>

                <span
                  style={{
                    whiteSpace: 'nowrap',
                    fontWeight: isSelected || isActive ? 600 : 400,
                  }}
                >
                  {node.name}
                </span>
              </div>

              {/* Progress Pill (Execution mode) or Plan-Inclusion Indicator (Specification
                  mode) -- pinned to the pane's right edge via position: sticky regardless of
                  horizontal scroll, per direct request ("buttons... should always remain
                  visible aligned to the right of each suite"). marginLeft: auto gives it its
                  un-scrolled position at the end of this row's (now full-width) box; the
                  opaque backgroundColor masks this row's own name text sliding underneath it
                  as the tree scrolls horizontally. The "✎ Fields" affordance that used to
                  live here was removed: clicking a suite row now shows its details (name +
                  custom fields) in Pane 3, the same place a case's details show, making a
                  separate button redundant. */}
              {mode === 'SPECIFICATION' ? (
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    flexShrink: 0,
                    marginLeft: 'auto',
                    position: 'sticky',
                    right: '8px',
                    backgroundColor: '#0d111c',
                    paddingLeft: '8px',
                  }}
                >
                {renderInclusionIndicator(node)}
                {canCreateSuites && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onCreateChildSuite?.(node.id);
                    }}
                    title="Create child suite"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: '16px',
                      height: '16px',
                      marginLeft: '4px',
                      borderRadius: '3px',
                      backgroundColor: 'transparent',
                      border: '1px solid #4b5563',
                      color: '#9ca3af',
                      fontSize: '10px',
                      cursor: 'pointer',
                      padding: 0,
                    }}
                  >
                    +
                  </button>
                )}
                {canEditSuites && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onRenameSuite?.(node.id, node.name, node.parentId ?? null);
                    }}
                    title="Rename / move suite"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: '16px',
                      height: '16px',
                      marginLeft: '4px',
                      borderRadius: '3px',
                      backgroundColor: 'transparent',
                      border: '1px solid #4b5563',
                      color: '#9ca3af',
                      fontSize: '10px',
                      cursor: 'pointer',
                      padding: 0,
                    }}
                  >
                    ✏️
                  </button>
                )}
                {canDeleteSuites && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteSuite?.(node.id);
                    }}
                    title="Delete suite"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: '16px',
                      height: '16px',
                      marginLeft: '4px',
                      borderRadius: '3px',
                      backgroundColor: 'transparent',
                      border: '1px solid #4b5563',
                      color: '#f87171',
                      fontSize: '10px',
                      cursor: 'pointer',
                      padding: 0,
                    }}
                  >
                    🗑️
                  </button>
                )}
                </span>
              ) : (
                total > 0 && (
                  <span
                    style={{
                      fontSize: '11px',
                      fontWeight: 600,
                      color: passed === total && total > 0 ? '#4ade80' : '#60a5fa',
                      backgroundColor: 'rgba(31, 41, 55, 0.8)',
                      padding: '1px 6px',
                      borderRadius: '9999px',
                      flexShrink: 0,
                      marginLeft: 'auto',
                      position: 'sticky',
                      right: '8px',
                    }}
                  >
                    {passed}/{total} P
                  </span>
                )
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
