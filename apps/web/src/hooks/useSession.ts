import { useCallback, useEffect, useState } from "react";
import type { UserProfile } from "../components/AuthModal";
import { SESSION_ENDED_NOTICE } from "../app/messages";
import { authHeaders, watchForEndedSession } from "../utils/session";

/**
 * Who is signed in, and signing in and out. The sign-in itself is an HttpOnly cookie (see
 * utils/session.ts); this holds the signed-in user and their permissions, checks the session
 * on load, signs out, and returns to the login screen when a sign-in ends on its own.
 */
export function useSession(showToast: (msg: string) => void) {
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  // Shown on the login screen after a sign-in ends on its own (see handleAuthExpiry).
  const [sessionEndedNotice, setSessionEndedNotice] = useState<string | null>(null);
  const [authChecking, setAuthChecking] = useState<boolean>(true);
  const [userPermissions, setUserPermissions] = useState<string[]>([]);

  // Shared 401 handling for the Spec-mode save handlers in App.tsx (create/approve/edit-content/
  // save-steps). Login tokens are still finite-lived (1 hour JWTs, no refresh mechanism -- see
  // packages/core/src/security/jwt.ts), and unlike verdict submission (a single fast POST),
  // Spec-mode editing is often a long, network-idle drafting session (typing into steps,
  // reordering, etc. is pure client-side state with zero requests) before the user finally
  // clicks Save/Approve -- so that click is often the first request issued after the token
  // has silently expired. Without this, the handler's generic catch surfaces the raw
  // "Unauthorized: Token expired" server string and leaves the user signed in on screen,
  // so every retry just fails the same way. Mirrors submitVerdict's existing 401 branch
  // (drop back to a logged-out state, toast a clear message) so every
  // Spec-mode save handler behaves the same way execution recording already does.
  const handleAuthExpiry = useCallback(() => {
    setSessionEndedNotice(SESSION_ENDED_NOTICE);
    setCurrentUser(null);
    setUserPermissions([]);
  }, []);

  // Any API request that finds the sign-in ended (from any screen or dialog) returns to the
  // login screen with a note, rather than leaving that screen showing the raw 401 error.
  useEffect(() => {
    if (!currentUser) return;
    return watchForEndedSession(handleAuthExpiry);
  }, [currentUser?.id, handleAuthExpiry]);

  // Fetch current user profile (/api/v1/auth/me) using the session cookie. No client-side
  // fallback session: if the server doesn't confirm it, the user is logged out. (This used to
  // fabricate a fake Admin session in the UI when a magic value was present or the request failed --
  // that never granted real API access once the server started requiring signed tokens, but it
  // could show a misleading "logged in as admin" state. Removed 2026-09-11.)
  const fetchCurrentUser = useCallback(async () => {
    try {
      // Sign-ins from before the cookie existed left a token in localStorage; it's no longer used.
      try {
        localStorage.removeItem("auth_token");
        localStorage.removeItem("user_id");
      } catch {
        // Storage unavailable -- nothing to clean up.
      }

      const res = await fetch("/api/v1/auth/me", { headers: authHeaders() });

      if (res.ok) {
        const data = await res.json();
        if (data.user) {
          setCurrentUser(data.user);
          setUserPermissions(data.user.permissions || []);
        } else {
          setCurrentUser(null);
        }
      } else {
        // No sign-in, or it expired/was ended -- show the login screen.
        setCurrentUser(null);
      }
    } catch {
      // Network error reaching the server -- treat as logged out rather than assuming a session.
      setCurrentUser(null);
    } finally {
      setAuthChecking(false);
    }
  }, []);

  // Logout handler
  const handleLogout = useCallback(async () => {
    try {
      // The server ends this session and clears the cookie.
      await fetch("/api/v1/auth/logout", { method: "POST", headers: authHeaders() });
    } catch {
      // Ignore network error on logout
    }
    setCurrentUser(null);
    setUserPermissions([]);
    showToast("Signed out successfully.");
  }, [showToast]);

  useEffect(() => {
    fetchCurrentUser();
  }, [fetchCurrentUser]);

  return {
    currentUser,
    setCurrentUser,
    userPermissions,
    setUserPermissions,
    sessionEndedNotice,
    setSessionEndedNotice,
    authChecking,
    fetchCurrentUser,
    handleLogout,
    handleAuthExpiry,
  };
}
