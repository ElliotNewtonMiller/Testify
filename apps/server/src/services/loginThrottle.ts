/**
 * Limits password guessing, in two layers:
 *
 * - Per account (stored on the user, so it holds across server instances): after
 *   ACCOUNT_LOCK_THRESHOLD wrong passwords in a row the account is locked for
 *   ACCOUNT_LOCK_SECONDS. While locked, sign-in is refused even with the right password, and
 *   each further wrong password locks it again. A successful sign-in or an admin unlock resets
 *   it. Wrong "current password" entries on the password-change form count too.
 * - Per client address (in memory, per server process): IP_FAILURE_LIMIT failed sign-ins within
 *   IP_WINDOW_SECONDS block further sign-in attempts from that address until the oldest failure
 *   leaves the window. This slows down guessing across many accounts. Behind a reverse proxy,
 *   set TRUST_PROXY=true so the real client address is used instead of the proxy's.
 */
export const ACCOUNT_LOCK_THRESHOLD = 20;
export const ACCOUNT_LOCK_SECONDS = 15 * 60;
// Kept above ACCOUNT_LOCK_THRESHOLD: someone locking their own account from one address should
// see the account lock (which an admin can clear), not an address block nobody can clear.
export const IP_FAILURE_LIMIT = 50;
export const IP_WINDOW_SECONDS = 15 * 60;

export class IpFailureLimiter {
  private failures = new Map<string, number[]>();

  constructor(
    private limit = IP_FAILURE_LIMIT,
    private windowMs = IP_WINDOW_SECONDS * 1000
  ) {}

  /** Seconds until this address may try again, or 0 if it isn't blocked. */
  retryAfterSeconds(ip: string, now = Date.now()): number {
    const recent = this.recent(ip, now);
    if (recent.length < this.limit) return 0;
    return Math.max(1, Math.ceil((recent[recent.length - this.limit] + this.windowMs - now) / 1000));
  }

  recordFailure(ip: string, now = Date.now()): void {
    const recent = this.recent(ip, now);
    recent.push(now);
    this.failures.set(ip, recent);
    // Keep memory bounded: occasionally drop addresses with nothing left in the window.
    if (this.failures.size > 10_000) {
      for (const [key, times] of this.failures) {
        if (times.every((t) => t <= now - this.windowMs)) this.failures.delete(key);
      }
    }
  }

  private recent(ip: string, now: number): number[] {
    return (this.failures.get(ip) ?? []).filter((t) => t > now - this.windowMs);
  }
}

/** Seconds left on an account lock, or 0 if the account isn't locked. */
export function accountLockSecondsLeft(lockedUntil: string | null | undefined, now = Date.now()): number {
  if (!lockedUntil) return 0;
  const ms = new Date(lockedUntil).getTime() - now;
  return ms > 0 ? Math.ceil(ms / 1000) : 0;
}

export function describeWait(seconds: number): string {
  const minutes = Math.ceil(seconds / 60);
  return minutes <= 1 ? 'a minute' : `${minutes} minutes`;
}
