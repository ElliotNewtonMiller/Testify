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

/** authHeaders() plus a JSON Content-Type, for requests with a JSON body. */
export function jsonHeaders(): Record<string, string> {
  return { ...CLIENT_HEADER, "Content-Type": "application/json" };
}

const SIGN_IN_ROUTES = new Set(["/api/v1/auth/login", "/api/v1/auth/me", "/api/v1/auth/logout"]);

/**
 * Calls `onEnded` when any API request comes back 401 -- the sign-in has ended (expired,
 * signed out elsewhere, password changed, or the server restarted with a new signing key) --
 * so the app returns to the login screen instead of each screen showing the raw error. The
 * sign-in routes are left out: their 401s are handled where they're called. Returns a
 * function that removes the watch.
 */
export function watchForEndedSession(onEnded: () => void): () => void {
  const original = window.fetch;
  const watched: typeof window.fetch = async (input, init) => {
    const res = await original(input, init);
    if (res.status === 401) {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(url, window.location.origin).pathname;
      if (path.startsWith("/api/") && !SIGN_IN_ROUTES.has(path)) onEnded();
    }
    return res;
  };
  window.fetch = watched;
  return () => {
    if (window.fetch === watched) window.fetch = original;
  };
}
