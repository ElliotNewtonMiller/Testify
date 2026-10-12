import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { createServer } from '../src/server.js';
import { IMPORT_JSON_BODY_LIMIT_BYTES, IMPORT_MAX_FILE_BYTES, MAX_CONCURRENT_IMPORTS } from '../src/routes/ingestion.js';

/** Import uploads are bounded: multipart for files, small JSON bodies, few imports at once. */
describe('Import size and concurrency limits', () => {
  let app: any;
  let seed: any;
  let token: string;
  const body = (res: any) => JSON.parse(res.payload || '{}');

  const xml = (filler = '') =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites><testsuite name="Limits Suite">${filler ? `<!-- ${filler} -->` : ''}` +
    `<testcase name="Limits case"><externalid><![CDATA[LIM-1]]></externalid><summary><![CDATA[s]]></summary></testcase>` +
    `</testsuite></testsuites>`;

  /** Builds a multipart body the way a browser's FormData would. */
  async function multipart(fields: Record<string, string>, files: Array<{ name: string; content: string | Buffer }>) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    for (const f of files) form.append('file', new Blob([f.content]), f.name);
    const req = new Request('http://local/', { method: 'POST', body: form });
    return { payload: Buffer.from(await req.arrayBuffer()), contentType: req.headers.get('content-type')! };
  }

  async function upload(url: string, fields: Record<string, string>, files: Array<{ name: string; content: string | Buffer }>) {
    const { payload, contentType } = await multipart(fields, files);
    return app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}`, 'content-type': contentType }, payload });
  }

  beforeEach(async () => {
    ({ app, seed } = await createServer());
    token = body(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } })).token;
  });
  afterEach(async () => {
    await app.close();
  });

  it('imports a multipart upload, including one larger than the JSON body limit', async () => {
    const fields = { target_project_id: seed.projectId, format: 'TESTLINK_XML' };
    const dry = await upload('/api/v1/imports/dry-run', fields, [{ name: 'small.xml', content: xml() }]);
    expect(dry.statusCode).toBe(200);
    expect(body(dry).dry_run_summary.total_cases_detected).toBe(1);

    const exec = await upload(
      '/api/v1/imports/execute',
      { ...fields, configuration: JSON.stringify({ duplicate_resolution: { default_action: 'VERSION_UP' } }) },
      [{ name: 'small.xml', content: xml() }]
    );
    expect(exec.statusCode).toBe(200);
    expect(JSON.stringify(body(exec))).toContain('"imported_cases_count":1');

    // Past the JSON limit, but fine as a file.
    const big = xml('x'.repeat(IMPORT_JSON_BODY_LIMIT_BYTES + 1024 * 1024));
    const bigRes = await upload('/api/v1/imports/dry-run', fields, [{ name: 'big.xml', content: big }]);
    expect(bigRes.statusCode).toBe(200);
  }, 60_000);

  it('refuses an oversized JSON body, an oversized file, and more than one file -- with a clear 413', async () => {
    const json = await app.inject({
      method: 'POST',
      url: '/api/v1/imports/dry-run',
      headers: { authorization: `Bearer ${token}` },
      payload: { file_content: xml('x'.repeat(IMPORT_JSON_BODY_LIMIT_BYTES)), target_project_id: seed.projectId },
    });
    expect(json.statusCode).toBe(413);
    expect(body(json).code).toBe('IMPORT_TOO_LARGE');
    expect(body(json).detail).toContain('multipart');

    const tooBig = await upload('/api/v1/imports/dry-run', { target_project_id: seed.projectId }, [
      { name: 'huge.xml', content: Buffer.alloc(IMPORT_MAX_FILE_BYTES + 1, 0x20) },
    ]);
    expect(tooBig.statusCode).toBe(413);
    expect(body(tooBig).code).toBe('IMPORT_TOO_LARGE');
    expect(body(tooBig).detail).toContain('50 MB');

    const two = await upload('/api/v1/imports/dry-run', { target_project_id: seed.projectId }, [
      { name: 'a.xml', content: xml() },
      { name: 'b.xml', content: xml() },
    ]);
    expect(two.statusCode).toBe(413);
    expect(body(two).detail).toBe('Send one file per import.');
  }, 60_000);

  it(`runs at most ${MAX_CONCURRENT_IMPORTS} imports at once; anonymous requests take no slot`, async () => {
    // Anonymous requests are refused before taking a slot.
    for (let i = 0; i < 3; i++) {
      const anon = await app.inject({ method: 'POST', url: '/api/v1/imports/dry-run', payload: { file_content: xml() } });
      expect(anon.statusCode).toBe(401);
    }

    // Hold every slot with uploads whose bodies haven't finished arriving.
    const { payload, contentType } = await multipart({ target_project_id: seed.projectId }, [{ name: 'slow.xml', content: xml() }]);
    const streams = Array.from({ length: MAX_CONCURRENT_IMPORTS }, () => new PassThrough());
    const held = streams.map((stream) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/imports/dry-run',
        headers: { authorization: `Bearer ${token}`, 'content-type': contentType },
        payload: stream,
      })
    );
    await new Promise((r) => setTimeout(r, 1000));

    const busy = await upload('/api/v1/imports/dry-run', { target_project_id: seed.projectId }, [{ name: 'c.xml', content: xml() }]);
    expect(busy.statusCode).toBe(429);
    expect(body(busy).code).toBe('IMPORT_BUSY');
    expect(busy.headers['retry-after']).toBeDefined();

    for (const s of streams) s.end(payload);
    for (const res of await Promise.all(held)) expect(res.statusCode).toBe(200);

    // Slots are given back once those finish.
    const after = await upload('/api/v1/imports/dry-run', { target_project_id: seed.projectId }, [{ name: 'd.xml', content: xml() }]);
    expect(after.statusCode).toBe(200);
  }, 60_000);
});
