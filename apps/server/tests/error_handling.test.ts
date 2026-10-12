import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'kysely';
import { createServer } from '../src/server.js';
import { isPublicError, publicErrorMessage, INTERNAL_ERROR_MESSAGE } from '../src/errors.js';

describe('isPublicError / publicErrorMessage', () => {
  it("keeps the code's own plain Error messages and hides everything else", () => {
    expect(isPublicError(new Error('PASSWORD_POLICY_VIOLATION: too short'))).toBe(true);
    expect(isPublicError(new TypeError("Cannot read properties of undefined (reading 'id')"))).toBe(false);
    class DatabaseError extends Error {}
    expect(isPublicError(new DatabaseError('relation "users" does not exist'))).toBe(false);
    expect(isPublicError('a string')).toBe(false);
    expect(publicErrorMessage(new Error('Readable'), 'fallback')).toBe('Readable');
    expect(publicErrorMessage(new RangeError('internal detail'), 'fallback')).toBe('fallback');
  });
});

describe('Server errors', () => {
  let app: any;
  let db: any;
  let seed: any;
  let token: string;

  beforeEach(async () => {
    ({ app, db, seed } = await createServer());
    // Test-only routes that fail the two ways real code can.
    app.get('/__test/db-error', async () => db.selectFrom('no_such_table' as any).selectAll().execute());
    app.get('/__test/bug', async () => (undefined as any).id);
    token = JSON.parse((await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } })).payload).token;
  });
  afterEach(async () => {
    await app.close();
  });

  const expectGeneric500 = (res: any, ...secrets: string[]) => {
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.payload);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(body).toMatchObject({ status: 500, code: 'INTERNAL_ERROR', detail: INTERNAL_ERROR_MESSAGE, request_id: expect.any(String) });
    for (const secret of secrets) expect(res.payload).not.toContain(secret);
  };

  it('a database error or a bug answers with a generic 500 and a request id, never the details', async () => {
    expectGeneric500(await app.inject({ method: 'GET', url: '/__test/db-error' }), 'no_such_table', 'relation');
    expectGeneric500(await app.inject({ method: 'GET', url: '/__test/bug' }), 'Cannot read', 'undefined');
  });

  it('a real route failing on the database hides the table and SQL', async () => {
    await sql`DROP TABLE report_schedules CASCADE`.execute(db);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${seed.projectId}/report-schedules`,
      headers: { authorization: `Bearer ${token}` },
    });
    expectGeneric500(res, 'report_schedules', 'does not exist', 'select');
  });

  it("keeps messages that are about the request: bad JSON, and the code's own validation errors", async () => {
    const badJson = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{"username": ',
    });
    expect(badJson.statusCode).toBe(400);
    expect(JSON.parse(badJson.payload).detail).toBeTruthy();

    const weak = await app.inject({
      method: 'PUT',
      url: '/api/v1/auth/credentials',
      headers: { authorization: `Bearer ${token}` },
      payload: { newPassword: 'weak', currentPassword: 'password' },
    });
    expect(weak.statusCode).toBe(400);
    expect(JSON.parse(weak.payload).detail).toContain('PASSWORD_POLICY_VIOLATION');
  });
});
