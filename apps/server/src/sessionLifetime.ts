/**
 * How long a sign-in lasts. Each request made with it pushes its end out to
 * SESSION_IDLE_SECONDS from now, so someone using the app is never signed out mid-work; it
 * ends after that long with no requests, and SESSION_MAX_SECONDS after signing in however much
 * it's used. The login token and the web app's cookie are valid for the maximum; the
 * server-side session (SessionRepository) decides when the sign-in really ends.
 */
export const SESSION_IDLE_SECONDS = 8 * 60 * 60;
export const SESSION_MAX_SECONDS = 7 * 24 * 60 * 60;
