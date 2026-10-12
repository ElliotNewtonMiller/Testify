import type { Kysely } from 'kysely';
import type { Database } from '@testify/db';

/**
 * EXECUTE_OVERWRITE: recording a result for a test case that already has one in the run.
 * Results are never edited -- a new one is added and becomes the case's verdict -- so this is
 * what "overwriting" a verdict means. Without the permission, the only re-record allowed is
 * adding notes to your own latest result with the same verdict (the web app's Ctrl+Enter
 * "submit notes" after picking a verdict).
 */
export const RESULT_OVERWRITE_MESSAGE =
  'This test case already has a result in this run. Changing it needs the EXECUTE_OVERWRITE permission.';

export function canOverwriteResults(permissions: string[]): boolean {
  return permissions.includes('EXECUTE_OVERWRITE') || permissions.includes('SYSTEM_ADMIN');
}

export interface LatestRunResult {
  verdict: string;
  tester_id: string;
}

/**
 * The latest result in a run for each test case (by test case id, across all of the case's
 * links to the plan -- a case removed and re-added keeps its results in the run).
 */
export async function latestResultsInRun(
  db: Kysely<Database>,
  runId: string,
  testCaseIds?: string[]
): Promise<Map<string, LatestRunResult>> {
  if (testCaseIds && testCaseIds.length === 0) return new Map();
  let query = db
    .selectFrom('test_results as e')
    .innerJoin('test_plan_cases as tpc', 'tpc.id', 'e.test_plan_case_id')
    .select(['tpc.test_case_id', 'e.verdict', 'e.tester_id'])
    .where('e.test_run_id', '=', runId)
    .orderBy('e.executed_at', 'desc')
    .orderBy('e.created_at', 'desc');
  if (testCaseIds) query = query.where('tpc.test_case_id', 'in', testCaseIds);
  const latest = new Map<string, LatestRunResult>();
  for (const row of await query.execute()) {
    if (!latest.has(row.test_case_id)) latest.set(row.test_case_id, { verdict: row.verdict, tester_id: row.tester_id });
  }
  return latest;
}

/** Whether recording `verdict` by `actorId` would overwrite `existing` (see the rule above). */
export function isOverwrite(existing: LatestRunResult | undefined, actorId: string, verdict: string): boolean {
  if (!existing) return false;
  return !(existing.tester_id === actorId && existing.verdict === verdict);
}
