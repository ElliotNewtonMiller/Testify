import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { v4 as uuidv4 } from 'uuid';
import type { Database } from '@testify/db';
import { EmailOutboxRepository, SystemSettingsRepository } from '@testify/db';
import { escapeHtml, isValidEmail } from '@testify/core';
import { requirePermission } from '../middleware/auth.js';
import { EMAIL_SETTING_KEYS, loadEmailSettings, sendEmail } from '../services/mailer.js';

/**
 * Outgoing email settings and the outbox (SYSTEM_ADMIN only):
 *
 * GET/PUT /api/v1/admin/email-settings      -- the password is never returned, only has_password.
 * POST    /api/v1/admin/email-settings/test  { to }
 * GET     /api/v1/admin/email-outbox?limit=&offset=
 * GET     /api/v1/admin/email-outbox/:id     -- with the full HTML, for previewing.
 */
export async function registerEmailAdminRoutes(app: FastifyInstance, db: Kysely<Database>, jwtSecret: string) {
  const settingsRepo = new SystemSettingsRepository(db);
  const outboxRepo = new EmailOutboxRepository(db);
  const gate = { preHandler: requirePermission('SYSTEM_ADMIN', db, jwtSecret) };

  async function publicSettings() {
    const s = await loadEmailSettings(db);
    return {
      smtp_host: s.smtp_host,
      smtp_port: s.smtp_port,
      smtp_secure: s.smtp_secure,
      smtp_user: s.smtp_user,
      has_password: Boolean(s.smtp_password),
      from: s.from,
      public_url: s.public_url,
      // Without a host nothing is actually sent -- emails only land in the outbox.
      delivery: s.smtp_host ? 'smtp' : 'capture_only',
    };
  }

  app.get('/api/v1/admin/email-settings', gate, async () => ({ settings: await publicSettings() }));

  app.put('/api/v1/admin/email-settings', gate, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const bad = (field: string, reason: string) => reply.status(400).send({ error: 'INVALID_PARAMS', message: `${field} ${reason}`, details: [{ param: field, reason }] });
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
    const passwordChanged = typeof body.smtp_password === 'string';
    if (passwordChanged) entries[EMAIL_SETTING_KEYS.smtp_password] = (body.smtp_password as string) || null;
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
        ip_address: null,
        user_agent: 'TestifyAdminService',
        created_at: new Date().toISOString(),
      })
      .execute();
    return { settings: await publicSettings() };
  });

  app.post('/api/v1/admin/email-settings/test', gate, async (request, reply) => {
    const to = String((request.body as any)?.to ?? '').trim().toLowerCase();
    if (!isValidEmail(to)) return reply.status(400).send({ error: 'INVALID_PARAMS', message: 'to must be an email address', details: [{ param: 'to', reason: 'must be an email address' }] });
    const settings = await loadEmailSettings(db);
    const where = settings.smtp_host ? `via ${settings.smtp_host}` : 'with no SMTP server configured, so it was only captured in the outbox';
    const outbox = await sendEmail(db, {
      to: [to],
      subject: 'Testify test email',
      html: `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#0f172a"><h2>Testify can send email</h2><p>This test was sent ${escapeHtml(where)}.</p></body></html>`,
      text: `Testify can send email. This test was sent ${where}.`,
      projectId: null,
      sentBy: request.user!.id,
    });
    return { outbox: { id: outbox.id, status: outbox.status, error: outbox.error } };
  });

  app.get('/api/v1/admin/email-outbox', gate, async (request) => {
    const q = request.query as { limit?: string; offset?: string };
    const limit = Math.min(Math.max(parseInt(q.limit || '', 10) || 50, 1), 200);
    const offset = Math.max(parseInt(q.offset || '', 10) || 0, 0);
    return outboxRepo.list({ limit, offset });
  });

  app.get('/api/v1/admin/email-outbox/:id', gate, async (request, reply) => {
    const entry = await outboxRepo.findById((request.params as { id: string }).id);
    if (!entry) return reply.status(404).send({ error: 'Not found' });
    return { entry };
  });
}
