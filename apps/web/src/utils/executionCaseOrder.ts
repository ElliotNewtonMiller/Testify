/**
 * Execution mode's `workspace.cases` array is plan-case append/insertion order, not
 * suite/folder order -- individually-added cases keep whatever sequence a user pinned them
 * in, and suite-cascade-added cases all collide at position 0 and get sorted by external_id
 * among themselves, interleaving suites within a subtree. `buildExecutionCaseOrder` re-groups
 * the same cases (by index into the original array, so existing selectedIndex-based code
 * needs no changes) into real suite-tree pre-order. A suite with zero cases simply
 * contributes nothing, which is exactly "skip empty folders" with no special-casing.
 */
export function buildExecutionCaseOrder(
  cases: Array<{ test_suite_id?: string | null }>,
  suiteOrder: string[],
): number[] {
  const casesBySuite = new Map<string, number[]>();
  cases.forEach((c, idx) => {
    if (!c.test_suite_id) return;
    const arr = casesBySuite.get(c.test_suite_id) || [];
    arr.push(idx);
    casesBySuite.set(c.test_suite_id, arr);
  });

  const ordered: number[] = [];
  for (const suiteId of suiteOrder) {
    const indices = casesBySuite.get(suiteId);
    if (indices) ordered.push(...indices);
  }

  // A case whose suite isn't in the tree for some reason still needs to be reachable
  // rather than silently dropped from keyboard navigation.
  const seen = new Set(ordered);
  cases.forEach((_, idx) => {
    if (!seen.has(idx)) ordered.push(idx);
  });

  return ordered;
}

/**
 * Given a suite-tree-ordered sequence of case indices (from buildExecutionCaseOrder) and the
 * currently selected case's index into the original array, returns the next case's index --
 * wrapping around to the first case in the first folder after the last case in the last
 * folder, rather than stopping. Returns null if currentIndex isn't present in order (e.g. an
 * empty plan), so the caller can leave selection untouched.
 */
export function nextExecutionCaseIndex(order: number[], currentIndex: number): number | null {
  if (order.length === 0) return null;
  const posInOrder = order.indexOf(currentIndex);
  if (posInOrder === -1) return null;
  return order[(posInOrder + 1) % order.length];
}
