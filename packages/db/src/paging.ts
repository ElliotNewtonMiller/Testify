/**
 * Keyset paging. A page ends with the sort key of its last row; the next page starts after it.
 * The cursor is that key, `<timestamp>|<id>` (or `<timestamp>|<timestamp>|<id>` for lists that
 * break ties on a second time), in base64url: opaque to callers, stable while rows are added, and
 * cheap for the database (no OFFSET).
 */
export interface PageCursor {
  ts: string;
  /** A second sort time, for lists ordered by two (e.g. a run's results: executed_at, then created_at). */
  ts2?: string;
  id: string;
}

export function encodeCursor(ts: string, id: string, ts2?: string): string {
  return Buffer.from(ts2 === undefined ? `${ts}|${id}` : `${ts}|${ts2}|${id}`, 'utf8').toString('base64url');
}

/** The cursor's key, or null when there's none or it isn't one of ours. */
export function decodeCursor(cursor: string | null | undefined): PageCursor | null {
  if (!cursor || !/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const parts = decoded.split('|');
  if (parts.some((p) => p === '')) return null;
  if (parts.length === 2) return { ts: parts[0], id: parts[1] };
  if (parts.length === 3) return { ts: parts[0], ts2: parts[1], id: parts[2] };
  return null;
}

export interface Page<T> {
  rows: T[];
  next_cursor: string | null;
}

/** Cuts the extra row a query fetched (limit + 1) and makes the next cursor from the last row kept. */
export function toPage<T>(rows: T[], limit: number, key: (row: T) => PageCursor): Page<T> {
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  if (rows.length <= limit || !last) return { rows: page, next_cursor: null };
  const k = key(last);
  return { rows: page, next_cursor: encodeCursor(k.ts, k.id, k.ts2) };
}
