// Pure helpers over the spec tree (GET .../spec-tree's nested suites) and the suite tree the
// Suite Tree pane draws.
import type { SuiteTreeNode } from "../components/VirtualizedSuiteTree";
import type { SpecSuiteNode } from "../types";

/** Keeps only suites whose id is in `keep` (the case-search response's suite_ids already
 * includes every ancestor of a match, so the result stays a connected tree). */
export function pruneSuiteTree(nodes: SpecSuiteNode[], keep: Set<string>): SpecSuiteNode[] {
  return nodes
    .filter((n) => keep.has(n.id))
    .map((n) => ({ ...n, children: pruneSuiteTree(n.children, keep) }));
}

/** The Suite Tree's nodes, with Execute mode's passed/total counts per suite. */
export function buildSuiteNodes(
  nodes: SpecSuiteNode[],
  execCountsBySuite: Map<string, { passed: number; total: number }>,
): SuiteTreeNode[] {
  return nodes.map((n) => {
    const exec = execCountsBySuite.get(n.id);
    return {
      id: n.id,
      name: n.name,
      path: n.path,
      parentId: n.parent_suite_id,
      children: buildSuiteNodes(n.children, execCountsBySuite),
      passedCount: exec?.passed ?? 0,
      totalCount: exec?.total ?? 0,
      inPlanCount: n.in_plan_count,
      totalCaseCount: n.total_case_count,
    };
  });
}

/** Ids of suites with sub-suites -- the ones that have an expand arrow. */
export function expandableSuiteIds(nodes: SuiteTreeNode[]): string[] {
  const ids: string[] = [];
  (function collect(list: SuiteTreeNode[]) {
    for (const n of list) {
      if (n.children && n.children.length > 0) {
        ids.push(n.id);
        collect(n.children);
      }
    }
  })(nodes);
  return ids;
}

/** Visible tree order (collapsed children excluded) -- what a Shift-range spans in the tree. */
export function visibleSuiteOrder(nodes: SuiteTreeNode[], expandedMap: Record<string, boolean>): string[] {
  const order: string[] = [];
  (function walkVisible(list: SuiteTreeNode[]) {
    for (const n of list) {
      order.push(n.id);
      if (n.children && n.children.length > 0 && (expandedMap[n.id] ?? true)) walkVisible(n.children);
    }
  })(nodes);
  return order;
}

/** Every suite's path and name, by id. */
export function suiteInfoById(nodes: SpecSuiteNode[]): Map<string, { path: string; name: string }> {
  const info = new Map<string, { path: string; name: string }>();
  (function walkAll(list: SpecSuiteNode[]) {
    for (const n of list) {
      info.set(n.id, { path: n.path, name: n.name });
      walkAll(n.children);
    }
  })(nodes);
  return info;
}

export function findSuiteNode(nodes: SpecSuiteNode[], suiteId: string): SpecSuiteNode | null {
  for (const node of nodes) {
    if (node.id === suiteId) return node;
    const found = findSuiteNode(node.children, suiteId);
    if (found) return found;
  }
  return null;
}

/** Flat, indented "Parent Suite" <select> option list for the suite create/rename form. */
export function flattenSuiteOptions(nodes: SuiteTreeNode[], depth = 0): Array<{ id: string; label: string }> {
  let result: Array<{ id: string; label: string }> = [];
  for (const node of nodes) {
    result.push({ id: node.id, label: `${"—".repeat(depth)} ${node.name}` });
    if (node.children && node.children.length > 0) {
      result = result.concat(flattenSuiteOptions(node.children, depth + 1));
    }
  }
  return result;
}

/** The ids from `fromId` to `toId` (inclusive) in `order` -- a Shift-click range. */
export function rangeBetween(order: string[], fromId: string, toId: string): string[] {
  const a = order.indexOf(fromId);
  const b = order.indexOf(toId);
  if (a < 0 || b < 0) return [toId];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}
