import { describe, it, expect } from 'vitest';
import { createDbClient } from '@testify/db';
import { createServer } from '../src/server.js';

describe('Server restart against the same database', () => {
  it('starts again without recreating the schema, re-seeding, or losing data', async () => {
    const db = createDbClient();
    try {
      const first = await createServer(undefined, { db });
      const login = async (app: any) =>
        JSON.parse((await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } })).payload).token;

      const token = await login(first.app);
      const created = await first.app.inject({
        method: 'POST',
        url: '/api/v1/projects',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Survives restarts', prefix: 'KEEP' },
      });
      expect(created.statusCode).toBe(201);
      const counts = async () => ({
        projects: Number((await db.selectFrom('projects').select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n),
        users: Number((await db.selectFrom('users').select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n),
        roles: Number((await db.selectFrom('roles').select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n),
      });
      const before = await counts();
      await first.app.close();

      // "Restart": a new server process against the same database.
      const second = await createServer(undefined, { db });
      expect(await counts()).toEqual(before); // nothing duplicated by the seeds
      const token2 = await login(second.app);
      const projects = JSON.parse((await second.app.inject({ method: 'GET', url: '/api/v1/projects', headers: { authorization: `Bearer ${token2}` } })).payload).projects;
      expect(projects.some((p: any) => p.prefix === 'KEEP')).toBe(true);
      await second.app.close();
    } finally {
      await db.destroy();
    }
  });
});
