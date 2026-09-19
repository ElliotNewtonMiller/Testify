import { randomBytes, createHash } from 'node:crypto';
import type { Kysely, Selectable, Insertable } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import type { Database, ApiTokensTable } from '../types.js';

export type ApiTokenRow = Selectable<ApiTokensTable>;
type NewApiTokenRow = Insertable<ApiTokensTable>;

export const API_TOKEN_PREFIX = 'tf_ci_';

export interface ApiToken {
  id: string;
  project_id: string;
  name: string;
  token_prefix: string;
  capabilities: string[];
  created_by: string;
  expires_at: string | null;
  is_revoked: boolean;
  last_used_at: string | null;
  created_at: string;
}

export interface CreateApiTokenInput {
  project_id: string;
  name: string;
  capabilities: string[];
  created_by: string;
  expires_at?: string | null;
}

export interface CreateApiTokenResult {
  token: ApiToken;
  /** The full raw token, e.g. "tf_ci_<64 hex chars>". Returned only from create() --
   * never stored anywhere and never retrievable again afterward. */
  plaintext: string;
}

/** Hashes a raw token for storage/lookup. Exported so apps/server's auth middleware
 * hashes an incoming Bearer value with the exact same function used at mint time. Plain
 * SHA-256, no per-token salt: token_hash has a UNIQUE index and must support O(1)
 * equality lookup at request-auth time, which a per-row-salted slow KDF (the scheme
 * user.repository.ts's hashPassword uses for human passwords) cannot support. A 32-byte
 * random token has enough entropy that an unsalted fast digest is safe -- the same
 * approach GitHub/Stripe use for API tokens. */
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function toApiToken(row: ApiTokenRow): ApiToken {
  return {
    id: row.id,
    project_id: row.project_id,
    name: row.name,
    token_prefix: row.token_prefix,
    capabilities: JSON.parse(row.capabilities),
    created_by: row.created_by,
    expires_at: row.expires_at,
    is_revoked: row.is_revoked === 1,
    last_used_at: row.last_used_at,
    created_at: row.created_at,
  };
}

export class ApiTokenRepository {
  constructor(private db: Kysely<Database>) {}

  /**
   * Mints a new token. Capability-ceiling validation (a requested capability must be
   * within the issuing admin's own effective permissions, and SYSTEM_ADMIN must never be
   * grantable) is deliberately NOT done here -- it's a cross-cutting RBAC business rule
   * that belongs in the route layer, matching this codebase's existing convention (see
   * resolveCaseLinkability in apps/server/src/routes/testPlanCases.ts). This repository
   * stays a thin CRUD layer with no RBAC awareness.
   */
  async create(input: CreateApiTokenInput): Promise<CreateApiTokenResult> {
    const id = uuidv7();
    const rawSuffix = randomBytes(32).toString('hex');
    const plaintext = `${API_TOKEN_PREFIX}${rawSuffix}`;
    const tokenHash = hashToken(plaintext);
    const tokenPrefix = `${API_TOKEN_PREFIX}${rawSuffix.slice(0, 8)}`;
    const now = new Date().toISOString();

    const row: NewApiTokenRow = {
      id,
      project_id: input.project_id,
      name: input.name,
      token_prefix: tokenPrefix,
      token_hash: tokenHash,
      capabilities: JSON.stringify(input.capabilities),
      created_by: input.created_by,
      expires_at: input.expires_at ?? null,
      is_revoked: 0,
      last_used_at: null,
      created_at: now,
    };

    await this.db.insertInto('api_tokens').values(row).execute();

    return { token: (await this.getById(id))!, plaintext };
  }

  async getById(id: string): Promise<ApiToken | undefined> {
    const row = await this.db.selectFrom('api_tokens').selectAll().where('id', '=', id).executeTakeFirst();
    return row ? toApiToken(row) : undefined;
  }

  /** The O(1) auth-time lookup a presented Bearer token resolves through. */
  async findByHash(tokenHash: string): Promise<ApiToken | undefined> {
    const row = await this.db
      .selectFrom('api_tokens')
      .selectAll()
      .where('token_hash', '=', tokenHash)
      .executeTakeFirst();
    return row ? toApiToken(row) : undefined;
  }

  /** Never selects token_hash -- this is the only read path the admin UI's token list
   * uses, and the plaintext/hash must never round-trip back out once minted. Includes
   * revoked tokens (shown greyed-out in the UI, not hidden) so an admin can still see a
   * revoked token's history/metadata. */
  async listByProject(projectId: string): Promise<ApiToken[]> {
    const rows = await this.db
      .selectFrom('api_tokens')
      .selectAll()
      .where('project_id', '=', projectId)
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map(toApiToken);
  }

  /** Best-effort -- a failure here must never fail the request it's attached to. */
  async touchLastUsed(id: string): Promise<void> {
    await this.db
      .updateTable('api_tokens')
      .set({ last_used_at: new Date().toISOString() })
      .where('id', '=', id)
      .execute();
  }

  /**
   * Soft-delete: sets is_revoked, never a hard DELETE. Revocation is always immediate/
   * safe (no "in use" collision the way a role/case delete can have), but the row's
   * forensic value (created_by, capabilities at mint time, last_used_at) is exactly what
   * you want to inspect *after* revoking a suspected-compromised token -- hard-deleting
   * would erase that trail. Scoped by project_id so a token can't be revoked via the
   * wrong project's URL. Revoking an already-revoked token is a no-op, not an error.
   */
  async revoke(id: string, projectId: string): Promise<boolean> {
    const result = await this.db
      .updateTable('api_tokens')
      .set({ is_revoked: 1 })
      .where('id', '=', id)
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    return (result.numUpdatedRows ?? 0n) > 0n;
  }
}
