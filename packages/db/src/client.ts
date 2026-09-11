import type { Kysely } from 'kysely';
import type { Database as DatabaseSchema } from './types.js';
import { createPostgresClient } from './dialects/postgres.js';

export interface DbClientConfig {
  /**
   * Postgres connection string for a real Postgres server (production / team deployments).
   * Omit for an ephemeral, zero-config PGlite (WASM Postgres) instance -- no server, no native
   * bindings, works identically on every machine. This is the only supported engine: Testify
   * targets Postgres-compatible SQL everywhere (PGlite locally, real Postgres in production)
   * rather than maintaining a second SQL dialect.
   */
  connectionString?: string;
}

export function createDbClient(config: DbClientConfig = {}): Kysely<DatabaseSchema> {
  return createPostgresClient(config.connectionString);
}
