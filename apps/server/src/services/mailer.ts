import type { Kysely } from 'kysely';
import nodemailer, { type Transporter } from 'nodemailer';
import type { Database, EmailOutboxEntry } from '@testify/db';
import { EmailOutboxRepository, SystemSettingsRepository } from '@testify/db';

/** system_settings keys for outgoing email. */
export const EMAIL_SETTING_KEYS = {
  smtp_host: 'email.smtp_host',
  smtp_port: 'email.smtp_port',
  smtp_secure: 'email.smtp_secure',
  smtp_user: 'email.smtp_user',
  smtp_password: 'email.smtp_password',
  from: 'email.from',
  public_url: 'app.public_url',
} as const;

export interface EmailSettings {
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_secure: boolean;
  smtp_user: string | null;
  smtp_password: string | null;
  from: string | null;
  /** Base URL of the Testify web app, for "Open in Testify" links. */
  public_url: string | null;
}

export async function loadEmailSettings(db: Kysely<Database>): Promise<EmailSettings> {
  const raw = await new SystemSettingsRepository(db).getMany(Object.values(EMAIL_SETTING_KEYS));
  const port = Number(raw[EMAIL_SETTING_KEYS.smtp_port]);
  return {
    smtp_host: raw[EMAIL_SETTING_KEYS.smtp_host] || null,
    smtp_port: Number.isInteger(port) && port > 0 ? port : null,
    smtp_secure: raw[EMAIL_SETTING_KEYS.smtp_secure] === 'true',
    smtp_user: raw[EMAIL_SETTING_KEYS.smtp_user] || null,
    smtp_password: raw[EMAIL_SETTING_KEYS.smtp_password] || null,
    from: raw[EMAIL_SETTING_KEYS.from] || null,
    public_url: raw[EMAIL_SETTING_KEYS.public_url] || null,
  };
}

const DEFAULT_FROM = 'Testify <testify@localhost>';

type TransportFactory = (settings: EmailSettings) => Transporter;

const smtpTransport: TransportFactory = (s) =>
  nodemailer.createTransport({
    host: s.smtp_host!,
    port: s.smtp_port ?? (s.smtp_secure ? 465 : 587),
    secure: s.smtp_secure,
    auth: s.smtp_user ? { user: s.smtp_user, pass: s.smtp_password ?? '' } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });

let transportFactory: TransportFactory = smtpTransport;

/** Tests swap in nodemailer's jsonTransport so nothing touches the network. */
export function setTransportFactoryForTests(factory: TransportFactory | null): void {
  transportFactory = factory ?? smtpTransport;
}

/**
 * Sends one email and records it in email_outbox, whatever happens. With no SMTP host
 * configured the email is only captured (status CAPTURED) -- that's how dev/test installs
 * see what would have gone out.
 */
export async function sendEmail(
  db: Kysely<Database>,
  email: { to: string[]; subject: string; html: string; text: string; projectId: string | null; scheduleId?: string | null; sentBy: string | null }
): Promise<EmailOutboxEntry> {
  const settings = await loadEmailSettings(db);
  let status: 'SENT' | 'CAPTURED' | 'FAILED' = 'CAPTURED';
  let error: string | null = null;
  if (settings.smtp_host) {
    try {
      await transportFactory(settings).sendMail({ from: settings.from || DEFAULT_FROM, to: email.to, subject: email.subject, html: email.html, text: email.text });
      status = 'SENT';
    } catch (err) {
      status = 'FAILED';
      error = err instanceof Error ? err.message : String(err);
    }
  }
  return new EmailOutboxRepository(db).add({
    project_id: email.projectId,
    schedule_id: email.scheduleId ?? null,
    subject: email.subject,
    recipients: email.to,
    html: email.html,
    text_body: email.text,
    status,
    error,
    sent_by: email.sentBy,
  });
}
