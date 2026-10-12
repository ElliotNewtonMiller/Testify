import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';

/** New cases get unique PREFIX-n ids, however many are created at once. */
describe('Case external ids', () => {
  let app: any;
  let db: any;
  let seed: any;
  let headers: Record<string, string>;
  const body = (res: any) => JSON.parse(res.payload || '{}');
  const ids = async () =>
    (await db.selectFrom('test_cases').select('external_id').where('project_id', '=', seed.projectId).execute()).map((r: any) => r.external_id);

  beforeEach(async () => {
    ({ app, db, seed } = await createServer());
    const token = body(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } })).token;
    headers = { authorization: `Bearer ${token}` };
  });
  afterEach(async () => {
    await app.close();
  });

  it('cases created at the same time all succeed with distinct, consecutive ids', async () => {
    // Note: the in-memory database has one connection, so these requests' transactions run
    // one after another and this can't reproduce the race itself (it passes without the lock
    // too). With a real Postgres connection pool they overlap, and lockExternalIds is what
    // keeps two of them from picking the same id. This checks the outcome and that the
    // locked path works end to end.
    // The seed's cases are SHOP-101..109 and SHOP-1010, so new ones start at SHOP-1011.
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        app.inject({
          method: 'POST',
          url: `/api/v1/projects/${seed.projectId}/cases`,
          headers,
          payload: { test_suite_id: seed.suiteId, title: `Parallel ${i}`, steps: [{ action: 'a', expected_result: 'b' }] },
        })
      )
    );
    expect(responses.map((r: any) => r.statusCode)).toEqual(Array(12).fill(201));
    const created = responses.map((r: any) => body(r).test_case.external_id).sort((a: string, b: string) => Number(a.slice(5)) - Number(b.slice(5)));
    expect(created).toEqual(Array.from({ length: 12 }, (_, i) => `SHOP-${1011 + i}`));
    // Each has its version and step.
    for (const r of responses) expect(body(r).version.steps).toHaveLength(1);
  });

  it('an import numbers cases without ids after the highest, skipping ids the file uses, and gives copies a new id', async () => {
    const unnumbered = Array.from(
      { length: 300 },
      (_, i) => `<testcase name="No id ${i}"><summary><![CDATA[s]]></summary></testcase>`
    ).join('');
    // New ids start at SHOP-1011 (after SHOP-1010). SHOP-1012 is used by the file itself, so
    // it's skipped; SHOP-101 already exists and is imported as a copy.
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?><testsuites><testsuite name="Bulk">` +
      unnumbered +
      `<testcase name="Explicit"><externalid><![CDATA[SHOP-1012]]></externalid></testcase>` +
      `<testcase name="Copy of an existing case"><externalid><![CDATA[SHOP-101]]></externalid></testcase>` +
      `</testsuite></testsuites>`;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${seed.projectId}/imports/execute`,
      headers,
      payload: {
        file_content: xml,
        format: 'TESTLINK_XML',
        configuration: { duplicate_resolution: { default_action: 'CREATE_NEW' } },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(body(res).summary.imported_cases_count).toBe(302);

    const all = await ids();
    expect(new Set(all).size).toBe(all.length); // no duplicates
    expect(all).toContain('SHOP-1012');
    const imported = all
      .map((id: string) => Number(id.slice(5)))
      .filter((n: number) => n > 1010)
      .sort((a: number, b: number) => a - b);
    // 301 generated (1011, 1013, 1014, ...) plus the file's own 1012: no gaps, no clashes.
    expect(imported).toEqual(Array.from({ length: 302 }, (_, i) => 1011 + i));

    // The copy of SHOP-101 got a fresh id; the original kept its own.
    const copy = await db.selectFrom('test_cases').select('external_id').where('title', '=', 'Copy of an existing case (Copy)').executeTakeFirst();
    expect(copy.external_id).not.toBe('SHOP-101');
  }, 60_000);
});
