import type { Kysely } from 'kysely';
import nodemailer, { type Transporter } from 'nodemailer';
import type { Database, LastEmail } from '@testify/db';
import { LastEmailRepository, SystemSettingsRepository } from '@testify/db';
import { getSecretBox, isEncryptedSecret, SecretDecryptError } from './secrets.js';

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
  /** A password is stored but can't be decrypted (SECRETS_KEY missing or changed). */
  smtp_password_unreadable: boolean;
  from: string | null;
  /** Base URL of the Testify web app, for "Open in Testify" links. */
  public_url: string | null;
}

export async function loadEmailSettings(db: Kysely<Database>): Promise<EmailSettings> {
  const raw = await new SystemSettingsRepository(db).getMany(Object.values(EMAIL_SETTING_KEYS));
  const port = Number(raw[EMAIL_SETTING_KEYS.smtp_port]);
  const stored = raw[EMAIL_SETTING_KEYS.smtp_password] || null;
  let password: string | null = stored;
  let unreadable = false;
  if (stored && isEncryptedSecret(stored)) {
    const box = getSecretBox();
    try {
      password = box ? box.decrypt(stored) : null;
      unreadable = !box;
    } catch (err) {
      if (!(err instanceof SecretDecryptError)) throw err;
      password = null;
      unreadable = true;
    }
  }
  return {
    smtp_host: raw[EMAIL_SETTING_KEYS.smtp_host] || null,
    smtp_port: Number.isInteger(port) && port > 0 ? port : null,
    smtp_secure: raw[EMAIL_SETTING_KEYS.smtp_secure] === 'true',
    smtp_user: raw[EMAIL_SETTING_KEYS.smtp_user] || null,
    smtp_password: password,
    smtp_password_unreadable: unreadable,
    from: raw[EMAIL_SETTING_KEYS.from] || null,
    public_url: raw[EMAIL_SETTING_KEYS.public_url] || null,
  };
}

export const SMTP_PASSWORD_UNREADABLE_MESSAGE =
  "The stored SMTP password can't be decrypted -- the server's SECRETS_KEY is missing or has changed. Re-enter the password in Admin Panel -> Email.";

/**
 * Encrypts an SMTP password stored in plaintext (by a version before encryption) once a key is
 * available. Without a key it's left as it is, with a warning in the log.
 */
export async function encryptStoredSmtpPassword(db: Kysely<Database>): Promise<void> {
  const repo = new SystemSettingsRepository(db);
  const stored = (await repo.getMany([EMAIL_SETTING_KEYS.smtp_password]))[EMAIL_SETTING_KEYS.smtp_password];
  if (!stored || isEncryptedSecret(stored)) return;
  const box = getSecretBox();
  if (box) {
    await repo.setMany({ [EMAIL_SETTING_KEYS.smtp_password]: box.encrypt(stored) });
  } else if (process.env.NODE_ENV !== 'test') {
    console.warn('[testify] The SMTP password is stored unencrypted. Set SECRETS_KEY (32+ characters) and restart to encrypt it.');
  }
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
 * Sends one email and records it as the last email, whatever happens (replacing the previous
 * one -- there's no log). With no SMTP host configured it's only captured (status CAPTURED),
 * so dev/test installs can still see what would have gone out.
 */
export async function sendEmail(
  db: Kysely<Database>,
  email: { to: string[]; subject: string; html: string; text: string; projectId: string | null; scheduleId?: string | null; sentBy: string | null }
): Promise<LastEmail> {
  const settings = await loadEmailSettings(db);
  let status: 'SENT' | 'CAPTURED' | 'FAILED' = 'CAPTURED';
  let error: string | null = null;
  if (settings.smtp_host && settings.smtp_password_unreadable) {
    status = 'FAILED';
    error = SMTP_PASSWORD_UNREADABLE_MESSAGE;
  } else if (settings.smtp_host) {
    try {
      await transportFactory(settings).sendMail({ from: settings.from || DEFAULT_FROM, to: email.to, subject: email.subject, html: email.html, text: email.text });
      status = 'SENT';
    } catch (err) {
      status = 'FAILED';
      error = err instanceof Error ? err.message : String(err);
    }
  }
  return new LastEmailRepository(db).record({
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
