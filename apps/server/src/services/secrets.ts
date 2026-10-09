import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Encrypts secrets stored in the database (today: the SMTP password) with AES-256-GCM, using a
 * key derived from SECRETS_KEY -- kept out of the database, so a database dump or backup alone
 * doesn't reveal them. Stored form: `enc:v1:<iv>:<auth tag>:<ciphertext>` (base64).
 *
 * The box is set once at startup (createServer) and read by the mailer, which also runs from the
 * scheduler outside any request.
 */
const PREFIX = 'enc:v1:';

export class SecretDecryptError extends Error {}

export class SecretBox {
  private constructor(private key: Buffer) {}

  static fromSecret(secret: string): SecretBox {
    return new SecretBox(Buffer.from(hkdfSync('sha256', secret, 'testify', 'stored-secrets-v1', 32)));
  }

  /** For the throwaway in-memory database: a key that lives as long as this process. */
  static ephemeral(): SecretBox {
    return new SecretBox(randomBytes(32));
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return `${PREFIX}${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ciphertext.toString('base64')}`;
  }

  decrypt(stored: string): string {
    const [iv, tag, ciphertext] = stored.slice(PREFIX.length).split(':');
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      throw new SecretDecryptError('Stored secret could not be decrypted (SECRETS_KEY is missing or has changed).');
    }
  }
}

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(PREFIX);
}

let current: SecretBox | null = null;

/** Set by createServer from SECRETS_KEY (see resolveSecretsKey in config.ts); null when unavailable. */
export function setSecretBox(box: SecretBox | null): void {
  current = box;
}

export function getSecretBox(): SecretBox | null {
  return current;
}
