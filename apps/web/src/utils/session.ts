/**
 * The sign-in lives in an HttpOnly session cookie the server sets (page scripts can't read it),
 * and the browser sends it with every same-origin /api request on its own. Requests that change
 * something must also carry this header -- the server's CSRF check for cookie sign-ins (see
 * apps/server/src/sessionCookie.ts). Sending it on every request is harmless and simplest.
 */
export const CLIENT_HEADER = { "X-Testify-Client": "web" } as const;

export function authHeaders(): Record<string, string> {
  return { ...CLIENT_HEADER };
}
