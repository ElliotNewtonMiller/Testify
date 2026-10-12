import type { FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database } from '@testify/db';

/**
 * Readable case ids. Anywhere the API takes a case id -- the `:caseId` path parameter,
 * `test_case_id` in the query or JSON body, `case_ids` in a JSON body -- it also takes the case's
 * readable id (its external id, e.g. SHOP-12). Once the caller is signed in, authenticateRequest
 * (middleware/auth.ts) replaces readable ids with internal ids (`applyCaseRefs`), so routes only
 * ever see internal ids.
 *
 * Readable ids are unique within a project, and normally across projects too (they start with the
 * project's prefix), but imported cases keep the ids from their file, so two projects can share
 * one. Then the request's project decides (the project the other ids name, or an API token's own
 * project); without one, the request is refused with `400 AMBIGUOUS_CASE_ID`. A value that
 * matches nothing is left as it is, so the route answers its usual 404.
 */

export type CaseRefResolution = { id: string; projectId: string } | { ambiguous: number } | { none: true };

/** A case id or readable id → the internal id (or why not). `projectId` settles a readable id shared by several projects. */
export async function resolveCaseRef(db: Kysely<Database>, ref: string, projectId: string | null): Promise<CaseRefResolution> {
  const rows = await db
    .selectFrom('test_cases')
    .select(['id', 'project_id'])
    .where((eb) => eb.or([eb('id', '=', ref), eb('external_id', '=', ref)]))
    .execute();
  const byId = rows.find((r) => r.id === ref);
  if (byId) return { id: byId.id, projectId: byId.project_id };
  const candidates = rows.length > 1 && projectId ? rows.filter((r) => r.project_id === projectId) : rows;
  if (candidates.length === 1) return { id: candidates[0].id, projectId: candidates[0].project_id };
  return candidates.length === 0 ? { none: true } : { ambiguous: candidates.length };
}

/** Where readable ids may appear in a request, as holders and keys to rewrite. */
function caseRefSlots(request: FastifyRequest): Array<{ holder: Record<string, unknown>; key: string; field: string }> {
  const slots: Array<{ holder: Record<string, unknown>; key: string; field: string }> = [];
  const params = request.params as Record<string, unknown> | undefined;
  const query = request.query as Record<string, unknown> | undefined;
  const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body) ? (request.body as Record<string, unknown>) : undefined;
  if (typeof params?.caseId === 'string') slots.push({ holder: params, key: 'caseId', field: 'caseId' });
  if (typeof query?.test_case_id === 'string') slots.push({ holder: query, key: 'test_case_id', field: 'test_case_id' });
  if (typeof body?.test_case_id === 'string') slots.push({ holder: body, key: 'test_case_id', field: 'test_case_id' });
  if (Array.isArray(body?.case_ids)) {
    const ids = body!.case_ids as unknown[];
    ids.forEach((v, i) => {
      if (typeof v === 'string') slots.push({ holder: ids as unknown as Record<string, unknown>, key: String(i), field: `case_ids[${i}]` });
    });
  }
  return slots;
}

export type AmbiguousCaseRef = { detail: string; invalid_params: Array<{ name: string; reason: string }> };

/** Replaces readable case ids in the request with internal ids; returns the problem if one is ambiguous. */
export async function applyCaseRefs(request: FastifyRequest, db: Kysely<Database>, projectId: string | null): Promise<AmbiguousCaseRef | null> {
  for (const slot of caseRefSlots(request)) {
    const ref = slot.holder[slot.key] as string;
    if (!ref) continue;
    const r = await resolveCaseRef(db, ref, projectId);
    if ('id' in r) slot.holder[slot.key] = r.id;
    else if ('ambiguous' in r) {
      return {
        detail: `'${ref}' is the readable id of test cases in ${r.ambiguous} projects. Use the case's id instead, or name its project in the request.`,
        invalid_params: [{ name: slot.field, reason: `matches cases in ${r.ambiguous} projects` }],
      };
    }
  }
  return null;
}
