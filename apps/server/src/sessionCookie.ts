import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * The web app's sign-in lives in an HttpOnly cookie instead of localStorage, so page scripts
 * (including injected ones) can't read or copy the login token. API clients, CI and MCP keep
 * using `Authorization: Bearer ...`, which always takes precedence over the cookie.
 *
 * - HttpOnly: invisible to JavaScript.
 * - SameSite=Strict: never sent on requests started by another site.
 * - Secure when the request arrived over HTTPS (behind a proxy, set TRUST_PROXY=true).
 * - Path=/api: only sent to the API.
 *
 * CSRF: a request authenticated by the cookie that changes something (anything but
 * GET/HEAD/OPTIONS) must also carry `X-Testify-Client: web`. Other origins can't add a custom
 * header without a CORS preflight, which the server refuses unless CORS_ORIGINS allows them,
 * so a cross-origin form or fetch can't act with the cookie even from a sibling subdomain.
 */
export const SESSION_COOKIE = 'testify_session';
export const CSRF_HEADER = 'x-testify-client';
export const CSRF_HEADER_VALUE = 'web';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function readSessionCookie(request: FastifyRequest): string | null {
  const header = request.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      const value = part.slice(eq + 1).trim();
      return value ? decodeURIComponent(value) : null;
    }
  }
  return null;
}

function cookieAttributes(request: FastifyRequest, maxAgeSeconds: number): string {
  const secure = request.protocol === 'https' ? '; Secure' : '';
  return `Path=/api; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`;
}

export function setSessionCookie(request: FastifyRequest, reply: FastifyReply, token: string, maxAgeSeconds: number): void {
  reply.header('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${cookieAttributes(request, maxAgeSeconds)}`);
}

export function clearSessionCookie(request: FastifyRequest, reply: FastifyReply): void {
  reply.header('Set-Cookie', `${SESSION_COOKIE}=; ${cookieAttributes(request, 0)}`);
}

/** True when a cookie-authenticated request may proceed (see CSRF above). */
export function passesCsrfCheck(request: FastifyRequest): boolean {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return true;
  return request.headers[CSRF_HEADER] === CSRF_HEADER_VALUE;
}

/**
 * Where this request's credential comes from: the Authorization header if it has one,
 * otherwise the session cookie. `null` when there's neither.
 */
export function requestCredential(request: FastifyRequest): { token: string; viaCookie: boolean } | null {
  const header = request.headers['authorization'];
  if (typeof header === 'string' && header.startsWith('Bearer ')) return { token: header.substring(7), viaCookie: false };
  const cookie = readSessionCookie(request);
  return cookie ? { token: cookie, viaCookie: true } : null;
}
