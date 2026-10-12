import { describe, it, expect, afterEach } from 'vitest';
import nodemailer from 'nodemailer';
import { createDbClient, SystemSettingsRepository } from '@testify/db';
import { createServer } from '../src/server.js';
import { resolveSecretsKey, ConfigError } from '../src/config.js';
import { SecretBox, SecretDecryptError, isEncryptedSecret } from '../src/services/secrets.js';
import { setTransportFactoryForTests } from '../src/services/mailer.js';

const KEY_A = 'a'.repeat(40);
const KEY_B = 'b'.repeat(40);

describe('SecretBox', () => {
  it('round-trips, uses a fresh IV each time, and refuses the wrong key or tampering', () => {
    const box = SecretBox.fromSecret(KEY_A);
    const one = box.encrypt('hunter2');
    expect(isEncryptedSecret(one)).toBe(true);
    expect(one).not.toContain('hunter2');
    expect(box.encrypt('hunter2')).not.toBe(one);
    expect(box.decrypt(one)).toBe('hunter2');
    expect(() => SecretBox.fromSecret(KEY_B).decrypt(one)).toThrow(SecretDecryptError);
    const tampered = one.slice(0, -4) + (one.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect(() => box.decrypt(tampered)).toThrow(SecretDecryptError);
  });

  it('resolveSecretsKey: SECRETS_KEY (32+ chars), a per-process key for the in-memory database, otherwise none', () => {
    expect(() => resolveSecretsKey({ inMemory: false }, { SECRETS_KEY: 'short' })).toThrow(ConfigError);
    expect(resolveSecretsKey({ inMemory: false }, { SECRETS_KEY: KEY_A })).toBeInstanceOf(SecretBox);
    expect(resolveSecretsKey({ inMemory: true }, {})).toBeInstanceOf(SecretBox);
    expect(resolveSecretsKey({ inMemory: false }, {})).toBeNull();
  });
});

describe('Stored SMTP password', () => {
  const previous = process.env.SECRETS_KEY;
  const apps: any[] = [];
  let db: any;
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    setTransportFactoryForTests(null);
    if (previous === undefined) delete process.env.SECRETS_KEY;
    else process.env.SECRETS_KEY = previous;
    await db?.destroy();
  });

  /** Starts a server on `db`; `real` makes it treat the database as a real (non-memory) one. */
  async function start(key: string | undefined, real = false) {
    if (key) process.env.SECRETS_KEY = key;
    else delete process.env.SECRETS_KEY;
    // A real database also requires JWT_SECRET.
    const { app } = await withEnv({ JWT_SECRET: real ? 'secrets-test-jwt-secret-0123456789' : undefined }, () =>
      createServer(real ? 'postgres://unused/testify' : undefined, { db })
    );
    apps.push(app);
    const token = JSON.parse((await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } })).payload).token;
    const call = (method: string, url: string, payload?: unknown) => app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });
    return { app, call };
  }
  const storedPassword = async () => (await new SystemSettingsRepository(db).getMany(['email.smtp_password']))['email.smtp_password'];

  it('is saved encrypted, never returned, and decrypted only to send', async () => {
    db = createDbClient();
    const { call } = await start(KEY_A);
    const saved = await call('PUT', '/api/v1/admin/email-settings', { smtp_host: 'smtp.example.com', smtp_user: 'mailer', smtp_password: 'hunter2' });
    expect(saved.statusCode).toBe(200);
    expect(saved.payload).not.toContain('hunter2');
    const stored = await storedPassword();
    expect(isEncryptedSecret(stored!)).toBe(true);
    expect(stored).not.toContain('hunter2');

    let usedPassword: string | null = null;
    setTransportFactoryForTests((s) => {
      usedPassword = s.smtp_password;
      return nodemailer.createTransport({ jsonTransport: true });
    });
    const sent = await call('POST', '/api/v1/admin/email-settings/test', { to: 'qa@example.com' });
    expect(JSON.parse(sent.payload).email.status).toBe('SENT');
    expect(usedPassword).toBe('hunter2');
  }, 30_000);

  it('encrypts a password saved in plaintext by an older version, at startup', async () => {
    db = createDbClient();
    await start(KEY_A);
    await new SystemSettingsRepository(db).setMany({ 'email.smtp_password': 'legacy-plain' });
    await start(KEY_A); // restart
    const stored = await storedPassword();
    expect(isEncryptedSecret(stored!)).toBe(true);
    expect(SecretBox.fromSecret(KEY_A).decrypt(stored!)).toBe('legacy-plain');
  }, 30_000);

  it('with a changed key, says the password must be entered again and fails sending instead of using garbage', async () => {
    db = createDbClient();
    const first = await start(KEY_A);
    await first.call('PUT', '/api/v1/admin/email-settings', { smtp_host: 'smtp.example.com', smtp_user: 'mailer', smtp_password: 'hunter2' });
    const { call } = await start(KEY_B);
    const settings = JSON.parse((await call('GET', '/api/v1/admin/email-settings')).payload).settings;
    expect(settings).toMatchObject({ has_password: true, password_unreadable: true });
    setTransportFactoryForTests(() => {
      throw new Error('must not try to send');
    });
    const sent = JSON.parse((await call('POST', '/api/v1/admin/email-settings/test', { to: 'qa@example.com' })).payload);
    expect(sent.email.status).toBe('FAILED');
    expect(sent.email.error).toContain('SECRETS_KEY');
  }, 30_000);

  it('on a real database without SECRETS_KEY, refuses to store a password', async () => {
    db = createDbClient();
    await start(KEY_A); // creates admin/password the in-memory way
    const { call } = await start(undefined, true);
    expect(JSON.parse((await call('GET', '/api/v1/admin/email-settings')).payload).settings.can_store_password).toBe(false);
    const res = await call('PUT', '/api/v1/admin/email-settings', { smtp_host: 'smtp.example.com', smtp_password: 'hunter2' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).code).toBe('SECRETS_KEY_REQUIRED');
    expect(await storedPassword()).toBeFalsy();
  });
});

/** Runs `fn` with these environment variables set (undefined = unset), then puts them back. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  apply(vars);
  try {
    return await fn();
  } finally {
    apply(previous);
  }
}
