import { describe, it, expect } from 'vitest';
import {
  buildSuiteNodes,
  expandableSuiteIds,
  findSuiteNode,
  flattenSuiteOptions,
  pruneSuiteTree,
  rangeBetween,
  suiteInfoById,
  visibleSuiteOrder,
} from '../utils/suiteTree';
import type { SpecSuiteNode } from '../types';

const node = (id: string, children: SpecSuiteNode[] = [], parent: string | null = null): SpecSuiteNode => ({
  id, name: id.toUpperCase(), path: `/${id}`, parent_suite_id: parent, children, total_case_count: 2, in_plan_count: 1,
});
// a
// ├─ a1
// │  └─ a1x
// └─ a2
// b
const TREE = [node('a', [node('a1', [node('a1x', [], 'a1')], 'a'), node('a2', [], 'a')]), node('b')];

describe('suiteTree', () => {
  it('pruneSuiteTree keeps only the given suites', () => {
    const pruned = pruneSuiteTree(TREE, new Set(['a', 'a2']));
    expect(pruned.map((n) => n.id)).toEqual(['a']);
    expect(pruned[0].children.map((n) => n.id)).toEqual(['a2']);
  });

  it('buildSuiteNodes carries counts and Execute-mode results per suite', () => {
    const built = buildSuiteNodes(TREE, new Map([['a1', { passed: 1, total: 3 }]]));
    expect(built[0]).toMatchObject({ id: 'a', name: 'A', parentId: null, passedCount: 0, totalCount: 0, inPlanCount: 1, totalCaseCount: 2 });
    expect(built[0].children?.[0]).toMatchObject({ id: 'a1', parentId: 'a', passedCount: 1, totalCount: 3 });
  });

  it('lists expandable suites, and visible order honours collapsed suites', () => {
    const built = buildSuiteNodes(TREE, new Map());
    expect(expandableSuiteIds(built)).toEqual(['a', 'a1']);
    expect(visibleSuiteOrder(built, {})).toEqual(['a', 'a1', 'a1x', 'a2', 'b']);
    expect(visibleSuiteOrder(built, { a1: false })).toEqual(['a', 'a1', 'a2', 'b']);
    expect(visibleSuiteOrder(built, { a: false })).toEqual(['a', 'b']);
  });

  it('finds suites and flattens them into indented options', () => {
    expect(findSuiteNode(TREE, 'a1x')?.name).toBe('A1X');
    expect(findSuiteNode(TREE, 'nope')).toBeNull();
    expect(suiteInfoById(TREE).get('a2')).toEqual({ path: '/a2', name: 'A2' });
    expect(flattenSuiteOptions(buildSuiteNodes(TREE, new Map())).map((o) => o.label)).toEqual([' A', '— A1', '—— A1X', '— A2', ' B']);
  });

  it('rangeBetween spans either direction, or just the target if an end is unknown', () => {
    const order = ['a', 'b', 'c', 'd'];
    expect(rangeBetween(order, 'b', 'd')).toEqual(['b', 'c', 'd']);
    expect(rangeBetween(order, 'd', 'b')).toEqual(['b', 'c', 'd']);
    expect(rangeBetween(order, 'x', 'c')).toEqual(['c']);
  });
});
