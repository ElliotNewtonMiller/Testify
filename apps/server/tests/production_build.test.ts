import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/server.js';
import { ConfigError, resolveWebDistDir } from '../src/config.js';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A stand-in for apps/web/dist. */
function fakeWebBuild(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'testify-web-'));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Testify</title><div id="root"></div>');
  mkdirSync(path.join(dir, 'assets'));
  writeFileSync(path.join(dir, 'assets', 'index-abc123.js'), 'console.log("app")');
  writeFileSync(path.join(dir, 'robots.txt'), 'User-agent: *');
  return dir;
}

describe('Production: the server serves the built web app', () => {
  let app: any;
  let webDir: string;

  beforeAll(async () => {
    webDir = fakeWebBuild();
    ({ app } = await createServer(undefined, { webDistDir: webDir }));
  });
  afterAll(async () => {
    await app.close();
    rmSync(webDir, { recursive: true, force: true });
  });

  const get = (url: string, method = 'GET') => app.inject({ method, url });

  it('serves index.html for the app and for any app address, never cached', async () => {
    for (const url of ['/', '/reports/run', '/some/deep/link?x=1']) {
      const res = await get(url);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.payload).toContain('<div id="root">');
    }
  });

  it('serves built files with their type; hashed assets are cached for a year', async () => {
    const js = await get('/assets/index-abc123.js');
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toMatch(/text\/javascript/);
    expect(js.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(js.headers['x-content-type-options']).toBe('nosniff');
    expect(js.payload).toBe('console.log("app")');

    const txt = await get('/robots.txt');
    expect(txt.headers['content-type']).toMatch(/text\/plain/);
    expect(txt.headers['cache-control']).toBe('no-cache');

    expect((await get('/assets/index-abc123.js', 'HEAD')).statusCode).toBe(200);
  });

  it('missing files, the API and other methods keep their usual 404s; nothing outside the build is served', async () => {
    expect((await get('/assets/missing.js')).statusCode).toBe(404);
    expect((await get('/favicon.ico')).statusCode).toBe(404);

    const api = await get('/api/v1/no-such-route');
    expect(api.statusCode).toBe(404);
    expect(api.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(JSON.parse(api.payload)).toMatchObject({ status: 404, code: 'NOT_FOUND', detail: expect.stringContaining('/api/v1/no-such-route') });
    expect((await get('/api/v1/auth/me')).statusCode).toBe(401); // real routes are untouched
    expect((await app.inject({ method: 'POST', url: '/somewhere' })).statusCode).toBe(404);

    for (const url of ['/../package.json', '/%2e%2e/%2e%2e/package.json', '/..%2f..%2fpackage.json', '/%00']) {
      const res = await get(url);
      expect(res.statusCode).toBe(404);
      expect(res.payload).not.toContain('"name"');
    }
  });

  it('without a build, only the API is served', async () => {
    const { app: apiOnly } = await createServer();
    const res = await apiOnly.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(404);
    await apiOnly.close();
  });

  it('WEB_DIST_DIR must hold an index.html; unset, the default is used only if a build is there', () => {
    const dir = fakeWebBuild();
    try {
      expect(resolveWebDistDir({ WEB_DIST_DIR: dir })).toBe(dir);
      expect(() => resolveWebDistDir({ WEB_DIST_DIR: path.join(dir, 'assets') })).toThrow(ConfigError);
      expect(resolveWebDistDir({}, dir)).toBe(dir);
      expect(resolveWebDistDir({}, path.join(dir, 'nothing-here'))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Production: the build runs with plain Node', () => {
  it('builds dist/server.js, which starts with node and serves the API and the web app', async () => {
    const built = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: serverDir, encoding: 'utf8', timeout: 60_000 });
    expect(built.status).toBe(0);

    const webDir = fakeWebBuild();
    const port = 41_000 + Math.floor(Math.random() * 2000);
    const child = spawn(process.execPath, ['dist/server.js'], {
      cwd: serverDir,
      env: { ...process.env, NODE_ENV: 'production-check', DATABASE_URL: 'memory', PORT: String(port), WEB_DIST_DIR: webDir },
    });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    try {
      const deadline = Date.now() + 30_000;
      while (!output.includes('[testify] Listening on') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      expect(output).toContain('[testify] Listening on');
      expect(output).toContain(`Serving the web app from ${webDir}`);

      const page = await fetch(`http://127.0.0.1:${port}/reports`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('<div id="root">');
      const me = await fetch(`http://127.0.0.1:${port}/api/v1/auth/me`);
      expect(me.status).toBe(401);
      const login = await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'password' }),
      });
      expect(login.status).toBe(200);
      // The API docs page and its files (served from node_modules by the bundled server).
      const docs = await fetch(`http://127.0.0.1:${port}/docs/`);
      expect(docs.status).toBe(200);
      expect(await docs.text()).toContain('swagger-ui');
      expect((await fetch(`http://127.0.0.1:${port}/docs/static/swagger-ui-bundle.js`)).status).toBe(200);
      expect((await (await fetch(`http://127.0.0.1:${port}/docs/json`)).json()).openapi).toBe('3.1.0');
    } finally {
      child.kill();
      rmSync(webDir, { recursive: true, force: true });
    }
  }, 90_000);
});
