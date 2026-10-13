import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { v4 as uuidv4 } from 'uuid';
import type { Database } from '@testify/db';
import { sendError, sendPlanLockedError } from '../errors.js';
import type { AuthenticatedUser } from '../middleware/auth.js';
import { emitRunCreated, webhookActor } from './webhookEvents.js';

export interface RunByName {
  id: string;
  name: string;
  /** True when this request created the run. */
  created: boolean;
}

/**
 * The plan's run with this name, created if there's none yet (needs RUN_MANAGE): what CI uses so
 * one build is one run, and a re-run job reuses it. Two jobs creating the same run at once both end
 * up with the one run. Answers the error itself (and returns null) when it can't.
 */
export async function findOrCreateRun(
  db: Kysely<Database>,
  request: FastifyRequest,
  reply: FastifyReply,
  user: AuthenticatedUser,
  planId: string,
  rawName: unknown
): Promise<RunByName | null> {
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  if (!name || name.length > 255) {
    sendError(reply, 400, 'run_name is required: the name of the run to record in (at most 255 characters), e.g. "CI build 1234"', {
      invalid_params: [{ name: 'run_name', reason: 'is required (at most 255 characters)' }],
    });
    return null;
  }
  const plan = await db.selectFrom('test_plans').select(['id', 'status', 'project_id']).where('id', '=', planId).executeTakeFirst();
  if (!plan || plan.project_id !== request.projectId) {
    sendError(reply, 404, 'Test plan not found');
    return null;
  }

  const existing = await db.selectFrom('test_runs').select(['id', 'name']).where('test_plan_id', '=', planId).where('name', '=', name).executeTakeFirst();
  if (existing) return { ...existing, created: false };

  if (plan.status === 'LOCKED' || plan.status === 'ARCHIVED') {
    sendPlanLockedError(reply, planId, request.url);
    return null;
  }
  if (!user.permissions.includes('RUN_MANAGE') && !user.permissions.includes('SYSTEM_ADMIN')) {
    sendError(reply, 403, `There's no run named "${name}" in this plan, and creating one needs RUN_MANAGE. Create it in Testify first, or use a token that has RUN_MANAGE.`, {
      required_permission: 'RUN_MANAGE',
    });
    return null;
  }
  const now = new Date().toISOString();
  const id = uuidv4();
  const inserted = await db
    .insertInto('test_runs')
    .values({ id, test_plan_id: planId, name, description: null, release_date: null, created_at: now, updated_at: now })
    .onConflict((oc) => oc.columns(['test_plan_id', 'name']).doNothing())
    .returning('id')
    .executeTakeFirst();
  if (inserted) {
    await emitRunCreated(db, webhookActor(user), id);
    return { id, name, created: true };
  }
  // Another request created it a moment ago.
  const raced = await db.selectFrom('test_runs').select(['id', 'name']).where('test_plan_id', '=', planId).where('name', '=', name).executeTakeFirstOrThrow();
  return { ...raced, created: false };
}
