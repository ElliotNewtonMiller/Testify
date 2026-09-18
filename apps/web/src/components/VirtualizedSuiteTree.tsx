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
  /** Fired when a suite's "Fields" affordance is clicked in Specification mode, to open
   * that suite's custom-fields panel. Purely additive -- doesn't change the existing
   * click-to-filter row selection behavior. */
  onOpenSuiteFields?: (suiteId: string) => void;
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
  onSelectSuite,
  onToggleExpand,
  mode = 'EXECUTION',
  canManagePlan = false,
  onToggleSuiteInclusion,
  onOpenSuiteFields,
}) => {
  const [expandedMap, setExpandedMap] = useState<Record<string, boolean>>({});

  const toggleSuite = useCallback(
    (suiteId: string, e?: React.MouseEvent) => {
      if (e) e.stopPropagation();
      setExpandedMap((prev) => {
        const nextState = !prev[suiteId];
        onToggleExpand?.(suiteId, nextState);
        return { ...prev, [suiteId]: nextState };
      });
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
        overflowY: 'auto',
        backgroundColor: '#0d111c',
        boxSizing: 'border-box',
      }}
    >
      {flatNodes.map(({ node, depth }) => {
        const isSelected = node.id === selectedSuiteId;
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
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingLeft: `${indentPx}px`,
              paddingRight: '8px',
              backgroundColor: isSelected ? 'rgba(59, 130, 246, 0.18)' : 'transparent',
              borderLeft: isSelected ? '3px solid #3b82f6' : '3px solid transparent',
              borderRadius: '2px',
              fontSize: '12px',
              color: isSelected ? '#ffffff' : '#d1d5db',
              cursor: 'pointer',
              userSelect: 'none',
              transition: 'background-color 0.1s ease',
            }}
          >
            {/* Folder Toggle Icon + Title */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden' }}>
              {hasChildren ? (
                <span
                  onClick={(e) => toggleSuite(node.id, e)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: '16px',
                    height: '16px',
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
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  fontWeight: isSelected ? 600 : 400,
                }}
              >
                {node.name}
              </span>
            </div>

            {/* Progress Pill (Execution mode) or Plan-Inclusion Indicator + Fields
                affordance (Specification mode) */}
            {mode === 'SPECIFICATION' ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
                {renderInclusionIndicator(node)}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenSuiteFields?.(node.id);
                  }}
                  title="Custom fields for this suite"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: '16px',
                    height: '16px',
                    marginLeft: '6px',
                    borderRadius: '3px',
                    backgroundColor: 'transparent',
                    border: '1px solid #4b5563',
                    color: '#9ca3af',
                    fontSize: '10px',
                    cursor: 'pointer',
                    padding: 0,
                  }}
                >
                  ✎
                </button>
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
                    marginLeft: '8px',
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
  );
};
