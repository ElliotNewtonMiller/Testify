import { randomBytes } from 'node:crypto';
import { validatePasswordPolicy } from '@testify/core';

/**
 * Where the server keeps its data, read from DATABASE_URL at startup. There's deliberately no
 * silent default: a missing DATABASE_URL used to fall back to a throwaway in-memory database,
 * so a deployment that forgot to set it looked fine and then lost everything on its first
 * restart.
 *
 * - `postgres://...` / `postgresql://...`: a real PostgreSQL server.
 * - `memory`: a throwaway in-memory database (PGlite). Development only -- all data is lost
 *   when the server stops. `npm run dev` uses it when DATABASE_URL isn't set.
 */
export interface DatabaseConfig {
  /** The PostgreSQL connection string, or undefined for the in-memory database. */
  connectionString: string | undefined;
  inMemory: boolean;
}

export const IN_MEMORY_DATABASE_URL = 'memory';

export class ConfigError extends Error {}

export function resolveDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const url = env.DATABASE_URL?.trim();
  if (!url) {
    throw new ConfigError(
      'DATABASE_URL is not set. Set it to your PostgreSQL connection string, ' +
        'e.g. DATABASE_URL=postgres://user:password@localhost:5432/testify. ' +
        `For a throwaway in-memory database (development only; all data is lost when the server stops), set DATABASE_URL=${IN_MEMORY_DATABASE_URL}.`
    );
  }
  if (url === IN_MEMORY_DATABASE_URL) {
    if (env.NODE_ENV === 'production') {
      throw new ConfigError(
        `DATABASE_URL=${IN_MEMORY_DATABASE_URL} isn't allowed when NODE_ENV=production: all data would be lost when the server stops. ` +
          'Set DATABASE_URL to your PostgreSQL connection string.'
      );
    }
    return { connectionString: undefined, inMemory: true };
  }
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    throw new ConfigError(
      'DATABASE_URL must be a PostgreSQL connection string starting with postgres:// or postgresql:// ' +
        `(or "${IN_MEMORY_DATABASE_URL}" for a throwaway in-memory database in development).`
    );
  }
  return { connectionString: url, inMemory: false };
}

/**
 * The password for the first admin user (username `admin`), created only when the database has
 * no users at all. There's no built-in default for a real database:
 *
 * - `ADMIN_PASSWORD` set: that password (it must meet the password policy). Not forced to change.
 * - In-memory database (development/tests): `password`. That data is thrown away anyway.
 * - Otherwise: a random password, printed once at startup, which must be changed at first sign-in.
 */
export interface InitialAdminPassword {
  password: string;
  mustChangePassword: boolean;
  source: 'env' | 'in_memory_default' | 'generated';
}

export function resolveInitialAdminPassword(
  { inMemory }: { inMemory: boolean },
  env: NodeJS.ProcessEnv = process.env
): InitialAdminPassword {
  const fromEnv = env.ADMIN_PASSWORD;
  if (fromEnv) {
    const check = validatePasswordPolicy(fromEnv);
    if (!check.valid) throw new ConfigError(`ADMIN_PASSWORD doesn't meet the password policy: ${check.reason}`);
    return { password: fromEnv, mustChangePassword: false, source: 'env' };
  }
  if (inMemory) return { password: 'password', mustChangePassword: false, source: 'in_memory_default' };
  // 24 characters: long enough that the policy needs no particular character types.
  return { password: randomBytes(18).toString('base64url'), mustChangePassword: true, source: 'generated' };
}
