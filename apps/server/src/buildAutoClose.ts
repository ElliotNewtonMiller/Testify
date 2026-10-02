import type { Kysely } from 'kysely';
import { v4 as uuidv4 } from 'uuid';
import type { Database } from '@testify/db';
import { BuildRepository } from '@testify/db';

/**
 * "When all the test cases have results, the run automatically closes." Called after an
 * execution is recorded (single and batch routes). Closes the build when every case in its
 * plan has a result in it, writes a BUILD_AUTO_CLOSED audit row when that happens, and
 * returns the build's resulting status so the caller can tell the client.
 */
export async function autoCloseBuildIfComplete(
  db: Kysely<Database>,
  buildId: string,
  actor: { id: string; type: 'USER' | 'SERVICE_ACCOUNT' }
): Promise<'OPEN' | 'CLOSED'> {
  const buildRepo = new BuildRepository(db);
  const closed = await buildRepo.closeIfComplete(buildId);
  if (closed) {
    const info = await db
      .selectFrom('builds')
      .innerJoin('test_plans', 'test_plans.id', 'builds.test_plan_id')
      .select(['test_plans.project_id', 'test_plans.id as plan_id'])
      .where('builds.id', '=', buildId)
      .executeTakeFirst();
    await db
      .insertInto('audit_logs')
      .values({
        id: uuidv4(),
        actor_id: actor.id,
        actor_type: actor.type,
        action: 'BUILD_AUTO_CLOSED',
        resource_type: 'build',
        resource_id: buildId,
        project_id: info?.project_id ?? null,
        diff: JSON.stringify({ reason: 'ALL_CASES_HAVE_RESULTS', plan_id: info?.plan_id ?? null }),
        ip_address: '127.0.0.1',
        user_agent: 'TestifyExecutionService',
        created_at: new Date().toISOString(),
      })
      .execute();
  }
  const build = await buildRepo.findById(buildId);
  return build?.status === 'CLOSED' ? 'CLOSED' : 'OPEN';
}
