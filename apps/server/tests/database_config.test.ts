import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolveDatabaseConfig, ConfigError } from '../src/config.js';

describe('resolveDatabaseConfig (DATABASE_URL)', () => {
  it('refuses a missing or blank DATABASE_URL instead of silently using a throwaway database', () => {
    for (const DATABASE_URL of [undefined, '', '   ']) {
      expect(() => resolveDatabaseConfig({ DATABASE_URL })).toThrow(ConfigError);
      expect(() => resolveDatabaseConfig({ DATABASE_URL })).toThrow(/DATABASE_URL is not set/);
    }
  });

  it('accepts a PostgreSQL connection string', () => {
    expect(resolveDatabaseConfig({ DATABASE_URL: 'postgres://u:p@db:5432/testify' })).toEqual({
      connectionString: 'postgres://u:p@db:5432/testify',
      inMemory: false,
    });
    expect(resolveDatabaseConfig({ DATABASE_URL: ' postgresql://db/testify ', NODE_ENV: 'production' }).connectionString).toBe(
      'postgresql://db/testify'
    );
  });

  it('uses the in-memory database only when asked for explicitly, and never in production', () => {
    expect(resolveDatabaseConfig({ DATABASE_URL: 'memory' })).toEqual({ connectionString: undefined, inMemory: true });
    expect(() => resolveDatabaseConfig({ DATABASE_URL: 'memory', NODE_ENV: 'production' })).toThrow(/isn't allowed when NODE_ENV=production/);
  });

  it('rejects anything that is not a PostgreSQL URL (e.g. a typo)', () => {
    for (const DATABASE_URL of ['memroy', 'mysql://db/testify', 'localhost:5432']) {
      expect(() => resolveDatabaseConfig({ DATABASE_URL })).toThrow(/must be a PostgreSQL connection string/);
    }
  });
});

describe('server startup', () => {
  it('exits with a clear message when DATABASE_URL is not set', () => {
    const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const tsx = path.resolve(serverDir, '../../node_modules/.bin/tsx');
    const env = { ...process.env, NODE_ENV: 'production', PORT: '0' };
    delete env.DATABASE_URL;
    const run = spawnSync(tsx, ['src/server.ts'], { cwd: serverDir, env, encoding: 'utf8', timeout: 30_000 });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('[testify] DATABASE_URL is not set');
  }, 40_000);
});
