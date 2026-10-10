import type { Kysely, Selectable } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import type { Database, SessionsTable } from '../types.js';

export type Session = Selectable<SessionsTable>;

/** Server-side record of each sign-in (see migration 003). */
export class SessionRepository {
  constructor(private db: Kysely<Database>) {}

  /** Starts a session for a sign-in, and clears that user's expired or revoked sessions. */
  async create(userId: string, lifetimeSeconds: number): Promise<Session> {
    const now = new Date();
    await this.db
      .deleteFrom('sessions')
      .where('user_id', '=', userId)
      .where((eb) => eb.or([eb('expires_at', '<=', now.toISOString()), eb('revoked_at', 'is not', null)]))
      .execute();
    const session = {
      id: uuidv7(),
      user_id: userId,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + lifetimeSeconds * 1000).toISOString(),
      revoked_at: null,
    };
    await this.db.insertInto('sessions').values(session).execute();
    return session;
  }

  /** The session if it belongs to the user and is still live (not revoked, not expired). */
  async findActive(sessionId: string, userId: string): Promise<Session | undefined> {
    return this.db
      .selectFrom('sessions')
      .selectAll()
      .where('id', '=', sessionId)
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', new Date().toISOString())
      .executeTakeFirst();
  }

  /**
   * Keeps a session that's in use alive: moves its end to `idleSeconds` from now, but never past
   * `maxSeconds` after it started. The write is skipped unless it moves the end by more than a
   * minute, so a busy session costs at most one update a minute. Returns the session's end.
   */
  async extend(session: Session, idleSeconds: number, maxSeconds: number, now = new Date()): Promise<string> {
    const cap = new Date(session.created_at).getTime() + maxSeconds * 1000;
    const next = Math.min(now.getTime() + idleSeconds * 1000, cap);
    if (next - new Date(session.expires_at).getTime() <= 60_000) return session.expires_at;
    const expiresAt = new Date(next).toISOString();
    await this.db
      .updateTable('sessions')
      .set({ expires_at: expiresAt })
      .where('id', '=', session.id)
      .where('revoked_at', 'is', null)
      .execute();
    return expiresAt;
  }

  async revoke(sessionId: string): Promise<void> {
    await this.db
      .updateTable('sessions')
      .set({ revoked_at: new Date().toISOString() })
      .where('id', '=', sessionId)
      .where('revoked_at', 'is', null)
      .execute();
  }

  /** Ends all of a user's live sessions, optionally keeping one (the caller's own). Returns how many. */
  async revokeAllForUser(userId: string, exceptSessionId?: string): Promise<number> {
    let query = this.db
      .updateTable('sessions')
      .set({ revoked_at: new Date().toISOString() })
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null);
    if (exceptSessionId) query = query.where('id', '!=', exceptSessionId);
    const result = await query.executeTakeFirst();
    return Number(result.numUpdatedRows);
  }
}
