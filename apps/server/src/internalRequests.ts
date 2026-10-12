import { randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

/**
 * Requests the server makes to itself on a caller's behalf: each item of a bulk change
 * (routes/bulkChanges.ts) and each change an MCP tool makes (mcp/mcpServer.ts) goes through the
 * ordinary route with `app.inject`, as the caller (their Authorization header or session cookie).
 * So permissions, validation, project binding and audit rows are exactly those of the single-item
 * routes.
 *
 * Such a request carries a secret only this process knows. It isn't counted again against an API
 * token's rate limit (the outer request was), and its `via` (bulk or mcp) is believed: an MCP
 * change is recorded with "via Testify MCP" in its audit rows' User-Agent, and cases it creates
 * start as DRAFT. The secret is random per process and never leaves it (headers aren't logged).
 */

const INTERNAL_SECRET = randomBytes(32).toString('hex');
const SECRET_HEADER = 'x-testify-internal';
const VIA_HEADER = 'x-testify-via';

export type InternalVia = 'bulk' | 'mcp';

export function isInternalRequest(request: FastifyRequest): boolean {
  return request.headers[SECRET_HEADER] === INTERNAL_SECRET;
}

/** How an internal request was made; null for every request from outside. */
export function internalVia(request: FastifyRequest): InternalVia | null {
  if (!isInternalRequest(request)) return null;
  const via = request.headers[VIA_HEADER];
  return via === 'bulk' || via === 'mcp' ? via : null;
}

export interface InnerResponse {
  status: number;
  body: any;
}

/** Calls one of the server's own routes as the caller of `outer`. */
export async function innerRequest(
  outer: FastifyRequest,
  via: InternalVia,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown
): Promise<InnerResponse> {
  const headers: Record<string, string> = { [SECRET_HEADER]: INTERNAL_SECRET, [VIA_HEADER]: via };
  for (const name of ['authorization', 'cookie', 'x-testify-client'] as const) {
    const value = outer.headers[name];
    if (typeof value === 'string') headers[name] = value;
  }
  const agent = typeof outer.headers['user-agent'] === 'string' ? outer.headers['user-agent'] : '';
  const MARK = '(via Testify MCP)';
  headers['user-agent'] = via === 'mcp' && !agent.includes(MARK) ? `${agent} ${MARK}`.trim() : agent;
  if (payload !== undefined) headers['content-type'] = 'application/json';
  const res = await outer.server.inject({
    method,
    url,
    headers,
    remoteAddress: outer.ip,
    ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
  });
  let body: any = null;
  try {
    body = res.payload ? JSON.parse(res.payload) : null;
  } catch {
    body = res.payload;
  }
  return { status: res.statusCode, body };
}
