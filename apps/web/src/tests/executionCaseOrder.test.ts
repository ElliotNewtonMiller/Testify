import { describe, it, expect } from 'vitest';
import { buildExecutionCaseOrder, nextExecutionCaseIndex } from '../utils/executionCaseOrder';

describe('buildExecutionCaseOrder', () => {
  it('groups cases by suite in suite-tree order, even when the input array interleaves suites', () => {
    // Index:        0        1        2        3        4
    const cases = [
      { test_suite_id: 'suiteB' },
      { test_suite_id: 'suiteA' },
      { test_suite_id: 'suiteB' },
      { test_suite_id: 'suiteA' },
      { test_suite_id: 'suiteC' },
    ];
    const order = buildExecutionCaseOrder(cases, ['suiteA', 'suiteB', 'suiteC']);
    // suiteA's cases (1, 3) first, then suiteB's (0, 2), then suiteC's (4) -- original
    // within-suite relative order preserved, just regrouped by suite.
    expect(order).toEqual([1, 3, 0, 2, 4]);
  });

  it('skips empty folders entirely -- a suite with zero cases contributes nothing', () => {
    const cases = [{ test_suite_id: 'suiteA' }, { test_suite_id: 'suiteC' }];
    const order = buildExecutionCaseOrder(cases, ['suiteA', 'suiteEmpty', 'suiteB', 'suiteC']);
    expect(order).toEqual([0, 1]);
  });

  it('appends cases with no matching suite in the tree, rather than dropping them', () => {
    const cases = [{ test_suite_id: 'suiteA' }, { test_suite_id: 'unknownSuite' }];
    const order = buildExecutionCaseOrder(cases, ['suiteA']);
    expect(order).toEqual([0, 1]);
  });

  it('appends cases with no suite id at all, rather than dropping them', () => {
    const cases = [{ test_suite_id: 'suiteA' }, {}];
    const order = buildExecutionCaseOrder(cases, ['suiteA']);
    expect(order).toEqual([0, 1]);
  });

  it('returns an empty array for an empty case list', () => {
    expect(buildExecutionCaseOrder([], ['suiteA'])).toEqual([]);
  });
});

describe('nextExecutionCaseIndex', () => {
  it('advances to the next case within the same folder', () => {
    // Cases 0 and 1 are both in the first folder in this order.
    expect(nextExecutionCaseIndex([0, 1, 2], 0)).toBe(1);
  });

  it('jumps to the first case of the next folder when at the last case of the current one', () => {
    // order = [caseA1, caseA2, caseB1] -- caseA2 (index 1 in `order`, value 1) is the last
    // case of folder A; the next entry (value 2) is folder B's first case.
    expect(nextExecutionCaseIndex([0, 1, 2], 1)).toBe(2);
  });

  it('wraps around to the first case in the first folder after the very last case overall', () => {
    expect(nextExecutionCaseIndex([0, 1, 2], 2)).toBe(0);
  });

  it('returns null when the current index is not present in the order (e.g. an empty plan)', () => {
    expect(nextExecutionCaseIndex([], 0)).toBeNull();
    expect(nextExecutionCaseIndex([1, 2], 5)).toBeNull();
  });

  it('wraps to itself when there is only one case total', () => {
    expect(nextExecutionCaseIndex([0], 0)).toBe(0);
  });
});
