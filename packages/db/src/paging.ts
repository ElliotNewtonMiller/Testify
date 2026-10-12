/**
 * Keyset paging. A page ends with the sort key of its last row; the next page starts after it.
 * The cursor is that key, `<timestamp>|<id>`, in base64url: opaque to callers, stable while rows
 * are added, and cheap for the database (no OFFSET).
 */
export interface PageCursor {
  ts: string;
  id: string;
}

export function encodeCursor(ts: string, id: string): string {
  return Buffer.from(`${ts}|${id}`, 'utf8').toString('base64url');
}

/** The cursor's key, or null when there's none or it isn't one of ours. */
export function decodeCursor(cursor: string | null | undefined): PageCursor | null {
  if (!cursor || !/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const sep = decoded.indexOf('|');
  if (sep <= 0 || sep === decoded.length - 1) return null;
  return { ts: decoded.slice(0, sep), id: decoded.slice(sep + 1) };
}

export interface Page<T> {
  rows: T[];
  next_cursor: string | null;
}

/** Cuts the extra row a query fetched (limit + 1) and makes the next cursor from the last row kept. */
export function toPage<T>(rows: T[], limit: number, key: (row: T) => PageCursor): Page<T> {
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { rows: page, next_cursor: rows.length > limit && last ? encodeCursor(key(last).ts, key(last).id) : null };
}
