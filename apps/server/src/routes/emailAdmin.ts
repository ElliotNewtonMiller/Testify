import type { FastifyInstance } from 'fastify';
import { withinRateLimit } from '../services/rateLimits.js';
import type { Kysely } from 'kysely';
import { v4 as uuidv4 } from 'uuid';
import type { Database } from '@testify/db';
import { LastEmailRepository, SystemSettingsRepository } from '@testify/db';
import { escapeHtml, isValidEmail } from '@testify/core';
import { requirePermission } from '../middleware/auth.js';
import { EMAIL_SETTING_KEYS, loadEmailSettings, sendEmail } from '../services/mailer.js';
import { getSecretBox } from '../services/secrets.js';
import { requestOrigin } from '../audit.js';

import { sendError } from '../errors.js';
import * as A from '../openapi/areas/admin.js';
/**
 * Outgoing email settings and the last email sent (SYSTEM_ADMIN only):
 *
 * GET/PUT /api/v1/admin/email-settings      -- the password is never returned, only has_password.
 * POST    /api/v1/admin/email-settings/test  { to }
 * GET     /api/v1/admin/last-email           -- the last email sent or captured (with its HTML), or null.
 */
export async function registerEmailAdminRoutes(app: FastifyInstance, db: Kysely<Database>, jwtSecret: string) {
  const settingsRepo = new SystemSettingsRepository(db);
  const lastEmailRepo = new LastEmailRepository(db);
  const gate = { preHandler: requirePermission('SYSTEM_ADMIN', db, jwtSecret) };

  async function publicSettings() {
    const s = await loadEmailSettings(db);
    return {
      smtp_host: s.smtp_host,
      smtp_port: s.smtp_port,
      smtp_secure: s.smtp_secure,
      smtp_user: s.smtp_user,
      has_password: Boolean(s.smtp_password) || s.smtp_password_unreadable,
      // Stored but undecryptable (SECRETS_KEY missing or changed): it must be entered again.
      password_unreadable: s.smtp_password_unreadable,
      // Without SECRETS_KEY (on a real database) no password can be stored.
      can_store_password: Boolean(getSecretBox()),
      from: s.from,
      public_url: s.public_url,
      // Without a host nothing is actually sent -- emails are only captured.
      delivery: s.smtp_host ? 'smtp' : 'capture_only',
    };
  }

  app.get('/api/v1/admin/email-settings', { schema: A.getEmailSettingsSchema, ...gate }, async () => ({ settings: await publicSettings() }));

  app.put('/api/v1/admin/email-settings', { schema: A.putEmailSettingsSchema, ...gate }, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const bad = (field: string, reason: string) => sendError(reply, 400, `${field} ${reason}`, { code: 'INVALID_PARAMS', invalid_params: [{ name: field, reason }] });
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

    const host = str(body.smtp_host);
    if (host.length > 255 || /\s/.test(host)) return bad('smtp_host', 'must be a host name');
    let port = '';
    if (body.smtp_port !== undefined && body.smtp_port !== null && body.smtp_port !== '') {
      const n = Number(body.smtp_port);
      if (!Number.isInteger(n) || n < 1 || n > 65535) return bad('smtp_port', 'must be a port number (1-65535)');
      port = String(n);
    }
    const from = str(body.from);
    if (from) {
      const address = /<([^>]+)>\s*$/.exec(from)?.[1] ?? from;
      if (!isValidEmail(address)) return bad('from', 'must be an email address, optionally as "Name <address>"');
    }
    const publicUrl = str(body.public_url).replace(/\/+$/, '');
    if (publicUrl && !/^https?:\/\/[^\s]+$/.test(publicUrl)) return bad('public_url', 'must start with http:// or https://');

    const entries: Record<string, string | null> = {
      [EMAIL_SETTING_KEYS.smtp_host]: host || null,
      [EMAIL_SETTING_KEYS.smtp_port]: port || null,
      [EMAIL_SETTING_KEYS.smtp_secure]: body.smtp_secure ? 'true' : null,
      [EMAIL_SETTING_KEYS.smtp_user]: str(body.smtp_user) || null,
      [EMAIL_SETTING_KEYS.from]: from || null,
      [EMAIL_SETTING_KEYS.public_url]: publicUrl || null,
    };
    // Password: left out = keep the current one; "" = remove it; anything else = replace it.
    // Stored encrypted (services/secrets.ts); refused when the server has no SECRETS_KEY.
    const passwordChanged = typeof body.smtp_password === 'string';
    if (passwordChanged) {
      const password = body.smtp_password as string;
      if (password) {
        const box = getSecretBox();
        if (!box) {
          return sendError(reply, 400, "The server can't store an SMTP password securely: set SECRETS_KEY (32+ characters) in its environment and restart it.", { code: 'SECRETS_KEY_REQUIRED' });
        }
        entries[EMAIL_SETTING_KEYS.smtp_password] = box.encrypt(password);
      } else {
        entries[EMAIL_SETTING_KEYS.smtp_password] = null;
      }
    }
    await settingsRepo.setMany(entries);

    await db
      .insertInto('audit_logs')
      .values({
        id: uuidv4(),
        actor_id: request.user!.id,
        actor_type: 'USER',
        action: 'EMAIL_SETTINGS_UPDATED',
        resource_type: 'system_settings',
        resource_id: 'email',
        project_id: null,
        diff: JSON.stringify({ smtp_host: host || null, smtp_port: port || null, smtp_user: str(body.smtp_user) || null, from: from || null, public_url: publicUrl || null, password_changed: passwordChanged }),
        ...requestOrigin(request),
        created_at: new Date().toISOString(),
      })
      .execute();
    return { settings: await publicSettings() };
  });

  app.post('/api/v1/admin/email-settings/test', { schema: A.testEmailSchema, ...gate }, async (request, reply) => {
    const to = String((request.body as any)?.to ?? '').trim().toLowerCase();
    if (!isValidEmail(to)) return sendError(reply, 400, 'to must be an email address', { code: 'INVALID_PARAMS', invalid_params: [{ name: 'to', reason: 'must be an email address' }] });
    if (!withinRateLimit(request, reply, app.rateLimits.reportEmails, 'emails')) return reply;
    const settings = await loadEmailSettings(db);
    const where = settings.smtp_host ? `via ${settings.smtp_host}` : 'with no SMTP server configured, so it was only captured, not sent';
    const sent = await sendEmail(db, {
      to: [to],
      subject: 'Testify test email',
      html: `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#0f172a"><h2>Testify can send email</h2><p>This test was sent ${escapeHtml(where)}.</p></body></html>`,
      text: `Testify can send email. This test was sent ${where}.`,
      projectId: null,
      sentBy: request.user!.id,
    });
    return { email: { status: sent.status, error: sent.error } };
  });

  app.get('/api/v1/admin/last-email', { schema: A.lastEmailSchema, ...gate }, async () => ({ email: (await lastEmailRepo.find()) ?? null }));
}
