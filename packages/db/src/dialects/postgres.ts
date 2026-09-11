import {
  Kysely,
  PostgresDialect,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import type { Database as DatabaseSchema } from '../types.js';

export function createPostgresClient(connectionString?: string): Kysely<DatabaseSchema> {
  if (!connectionString) {
    const pglite = new PGlite();
    return new Kysely<DatabaseSchema>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => ({
          async init() {},
          async acquireConnection(): Promise<any> {
            return {
              async executeQuery(compiledQuery: any) {
                const res = await pglite.query(compiledQuery.sql, compiledQuery.parameters as any[]);
                return {
                  rows: (res.rows || []) as any[],
                  numAffectedRows: res.affectedRows !== undefined ? BigInt(res.affectedRows) : undefined,
                };
              },
              async streamQuery() {
                throw new Error('Streaming not supported in PGlite driver');
              },
            };
          },
          async releaseConnection() {},
          async destroy() {
            await pglite.close();
          },
          async beginTransaction(connection: any) {
            await connection.executeQuery({ sql: 'BEGIN', parameters: [] });
          },
          async commitTransaction(connection: any) {
            await connection.executeQuery({ sql: 'COMMIT', parameters: [] });
          },
          async rollbackTransaction(connection: any) {
            await connection.executeQuery({ sql: 'ROLLBACK', parameters: [] });
          },
        }),
        createIntrospector: (db: any) => new PostgresIntrospector(db),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
    });
  }

  return new Kysely<DatabaseSchema>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        connectionString,
      }),
    }),
  });
}
