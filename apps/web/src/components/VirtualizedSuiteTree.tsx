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
}

export interface VirtualizedSuiteTreeProps {
  suites: SuiteTreeNode[];
  selectedSuiteId?: string | null;
  onSelectSuite?: (suiteId: string) => void;
  onToggleExpand?: (suiteId: string, expanded: boolean) => void;
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

            {/* Progress Pill (e.g. 12/15 P) */}
            {total > 0 && (
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
            )}
          </div>
        );
      })}
    </div>
  );
};
