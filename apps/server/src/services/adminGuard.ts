import type { Kysely } from 'kysely';
import type { Database } from '@testify/db';
import { RoleRepository, UserRepository } from '@testify/db';
import { PERMISSION_KEYS } from '@testify/core';
import type { AuthenticatedUser } from '../middleware/auth.js';

/**
 * Guards every change to who-can-do-what (users, roles, role assignments, permission
 * overrides). USER_MANAGE lets someone manage users, but on its own it used to let them make
 * themselves (or anyone) a full admin. Three rules close that:
 *
 * 1. Ceiling: a change can't give anyone a permission the person making it doesn't have
 *    themselves (at the same scope: global, or the project involved). That includes their own
 *    account, so nobody can raise their own access.
 * 2. Rank: you can't change a user who has permissions you don't (e.g. a user manager can't
 *    demote, disable or edit an admin). Your own account is exempt -- lowering it is fine.
 * 3. Last admin: no change may leave zero active users holding SYSTEM_ADMIN.
 *
 * Rules 1 and 3 are checked by comparing everyone the change touches before and after, inside
 * one transaction that's rolled back on a violation -- so they hold whatever path a permission
 * arrives by (role assignment, editing a role, removing a deny override, ...).
 */
export class AdminGuardError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

/** A user's permissions at one scope: global (projectId null) or within one project. */
export interface PermissionScope {
  userId: string;
  projectId: string | null;
}

const scopeKey = (s: PermissionScope) => `${s.userId}|${s.projectId ?? ''}`;

export class AdminGuard {
  constructor(private db: Kysely<Database>) {}

  /** The actor's own permissions at a scope -- the most they can hand out there. */
  async ceiling(actor: AuthenticatedUser, projectId: string | null, roles = new RoleRepository(this.db)): Promise<string[]> {
    return roles.evaluatePermissions(actor.id, projectId);
  }

  /** Rule 1 for a plain list of keys (a role template, or a role being given to a new user). */
  async assertCanGrant(actor: AuthenticatedUser, keys: string[], projectId: string | null = null): Promise<void> {
    const ceiling = new Set(await this.ceiling(actor, projectId));
    // Unknown keys are left to the repositories, which reject them with a 400.
    const missing = [...new Set(keys)].filter((k) => PERMISSION_KEYS.includes(k) && !ceiling.has(k));
    if (missing.length > 0) throw ceilingError(missing, projectId);
  }

  /**
   * Runs `mutate` in a transaction and enforces all three rules for the users/scopes it affects.
   * `scopes` may be a function of the transaction (e.g. "everyone who holds this role").
   */
  async run<T>(
    actor: AuthenticatedUser,
    scopes: PermissionScope[] | ((trx: Kysely<Database>) => Promise<PermissionScope[]>),
    mutate: (trx: Kysely<Database>) => Promise<T>
  ): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      const roles = new RoleRepository(trx);
      const users = new UserRepository(trx);
      const affected = dedupe(typeof scopes === 'function' ? await scopes(trx) : scopes);

      const ceilings = new Map<string, Set<string>>();
      const ceilingFor = async (projectId: string | null) => {
        const key = projectId ?? '';
        if (!ceilings.has(key)) ceilings.set(key, new Set(await this.ceiling(actor, projectId, roles)));
        return ceilings.get(key)!;
      };

      const before = new Map<string, string[]>();
      for (const s of affected) {
        const perms = await roles.evaluatePermissions(s.userId, s.projectId);
        before.set(scopeKey(s), perms);
        const ceiling = await ceilingFor(s.projectId);
        if (s.userId !== actor.id) {
          const outranks = perms.filter((p) => !ceiling.has(p));
          if (outranks.length > 0) {
            const target = await users.findById(s.userId);
            throw new AdminGuardError(
              403,
              'TARGET_OUTRANKS_ACTOR',
              `You can't change ${target?.username ?? 'this user'}${s.projectId ? ' in this project' : ''}: they have permissions you don't (${outranks.join(', ')}).`,
              { user_id: s.userId, project_id: s.projectId, permissions: outranks }
            );
          }
        }
      }

      const result = await mutate(trx);

      for (const s of affected) {
        const prior = new Set(before.get(scopeKey(s)));
        const ceiling = await ceilingFor(s.projectId);
        const gainedBeyondCeiling = (await roles.evaluatePermissions(s.userId, s.projectId)).filter(
          (p) => !prior.has(p) && !ceiling.has(p)
        );
        if (gainedBeyondCeiling.length > 0) throw ceilingError(gainedBeyondCeiling, s.projectId);
      }

      if (!(await roles.hasActiveSystemAdmin())) {
        throw new AdminGuardError(
          409,
          'LAST_ADMIN',
          'This would leave no active administrator (no active user with SYSTEM_ADMIN). Make someone else an admin first.'
        );
      }
      return result;
    });
  }
}

function ceilingError(missing: string[], projectId: string | null): AdminGuardError {
  return new AdminGuardError(
    403,
    'PERMISSION_CEILING',
    `You can't grant permissions you don't have yourself${projectId ? ' in this project' : ''}: ${missing.join(', ')}.`,
    { permissions: missing, project_id: projectId }
  );
}

function dedupe(scopes: PermissionScope[]): PermissionScope[] {
  const seen = new Map<string, PermissionScope>();
  for (const s of scopes) seen.set(scopeKey(s), s);
  return [...seen.values()];
}
