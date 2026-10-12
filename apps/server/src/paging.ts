import type { FastifyReply, FastifyRequest } from 'fastify';
import { decodeCursor } from '@testify/db';
import { sendError } from './errors.js';

/**
 * Paging for lists that grow (docs/rfc_03_api_and_xml_contracts.md §1.1): `?limit=` (default and
 * maximum per list) and `?cursor=` (the previous page's `next_cursor`). Every page answers
 * `next_cursor`, null on the last page.
 */
export interface PageRequest {
  limit: number;
  cursor: string | null;
}

/** The page asked for, or null after answering 400 INVALID_CURSOR. (`limit`'s range is checked by the route schema.) */
export function readPage(request: FastifyRequest, reply: FastifyReply, defaultLimit: number): PageRequest | null {
  const query = (request.query ?? {}) as { limit?: number; cursor?: string };
  const cursor = typeof query.cursor === 'string' && query.cursor !== '' ? query.cursor : null;
  if (cursor && !decodeCursor(cursor)) {
    sendError(reply, 400, "cursor isn't one this server gave out: use the previous page's next_cursor, or leave it out for the first page", {
      code: 'INVALID_CURSOR',
      invalid_params: [{ name: 'cursor', reason: 'is not a next_cursor from this list' }],
    });
    return null;
  }
  return { limit: typeof query.limit === 'number' ? query.limit : defaultLimit, cursor };
}

/** `"A,B , C"` → `["A", "B", "C"]`; undefined for nothing. */
export function commaList(value: unknown): string[] | undefined {
  if (typeof value !== 'string') return undefined;
  const items = value.split(',').map((v) => v.trim()).filter(Boolean);
  return items.length ? items : undefined;
}
