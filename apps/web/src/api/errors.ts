/**
 * The API sends every error as problem details (`application/problem+json`): the human-readable
 * message is `detail`, and `code` is a stable machine-readable code. This returns the message to
 * show from a parsed error body, or "" if there isn't one -- callers add their own fallback:
 *
 *   throw new Error(errorMessage(data) || "Failed to save");
 */
export function errorMessage(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const b = body as { detail?: unknown; error?: unknown; message?: unknown };
  for (const value of [b.detail, b.error, b.message]) {
    if (typeof value === "string" && value) return value;
  }
  return "";
}

/** The `code` of a parsed error body, or "" (e.g. "SESSION_ENDED", "RATE_LIMITED"). */
export function errorCode(body: unknown): string {
  const code = body && typeof body === "object" ? (body as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : "";
}
