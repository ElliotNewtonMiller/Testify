import type { Kysely } from 'kysely';
import { v4 as uuidv4 } from 'uuid';
import type { Database } from '@testify/db';
import { BuildRepository } from '@testify/db';
import { NO_ORIGIN, type RequestOrigin } from './audit.js';

/**
 * The run closes automatically the FIRST time every case in its plan has a result. Called
 * after an execution is recorded (single and batch routes). Writes a BUILD_AUTO_CLOSED audit
 * row when it fires, and that row is also what makes it once-only: a run that has already
 * auto-closed (and was then reopened to change a result) is never auto-closed again. Audit
 * rows are immutable, so this can't be reset by accident. Returns the build's resulting
 * status so the caller can tell the client.
 */
export async function autoCloseBuildIfComplete(
  db: Kysely<Database>,
  buildId: string,
  actor: { id: string; type: 'USER' | 'SERVICE_ACCOUNT' },
  /** The request whose result completed the run. */
  origin: RequestOrigin = NO_ORIGIN
): Promise<'OPEN' | 'CLOSED'> {
  const buildRepo = new BuildRepository(db);
  const alreadyAutoClosed = await db
    .selectFrom('audit_logs')
    .select('id')
    .where('action', '=', 'BUILD_AUTO_CLOSED')
    .where('resource_type', '=', 'build')
    .where('resource_id', '=', buildId)
    .executeTakeFirst();
  const closed = alreadyAutoClosed ? false : await buildRepo.closeIfComplete(buildId);
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
        ...origin,
        created_at: new Date().toISOString(),
      })
      .execute();
  }
  const build = await buildRepo.findById(buildId);
  return build?.status === 'CLOSED' ? 'CLOSED' : 'OPEN';
}
