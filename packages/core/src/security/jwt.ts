import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Minimal, dependency-free HMAC-SHA256 JWT (RFC 7519 / JWS compact serialization,
 * "HS256" only). Built on Node's built-in `node:crypto` rather than a third-party
 * library -- there's nothing exotic here (three base64url segments, an HMAC
 * signature, `exp` checked on verify) and it keeps the security-critical auth path
 * free of a supply-chain dependency. If a broader JWT feature set (other algorithms,
 * JWKS, etc.) is ever needed, swap this for `jsonwebtoken`/`jose` -- the token format
 * produced here is a standard, interoperable JWT either way.
 */

export interface JwtPayload {
  /** Subject -- Testify uses this as the authenticated user's id. */
  sub: string;
  iat: number;
  exp: number;
  [key: string]: unknown;
}

export interface JwtVerifyResult {
  valid: boolean;
  payload?: JwtPayload;
  reason?: string;
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function base64UrlDecode(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8');
}

function computeSignature(signingInput: string, secret: string): string {
  return createHmac('sha256', secret).update(signingInput).digest('base64url');
}

/**
 * Signs a JWT with HS256. `payload.sub` should be set by the caller (the user id).
 * `expiresInSeconds` defaults to 1 hour -- the original 15-minute default (matching the
 * previous insecure token's lifetime) proved too short in practice: Spec-mode editing
 * sessions are often long stretches of pure client-side typing with zero requests (see
 * handleAuthExpiry's comment in App.tsx), so a save click would routinely be the first
 * request issued after the token had already silently expired.
 */
export function signJwt(payload: Record<string, unknown> & { sub: string }, secret: string, expiresInSeconds = 60 * 60): string {
  if (!secret) {
    throw new Error('signJwt: secret is required');
  }

  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: JwtPayload = {
    ...payload,
    sub: payload.sub,
    iat: now,
    exp: now + expiresInSeconds,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = computeSignature(signingInput, secret);

  return `${signingInput}.${signature}`;
}

/**
 * Verifies a JWT's signature and expiry. Never throws -- returns
 * `{ valid: false, reason }` for any malformed, mis-signed, or expired token.
 */
export function verifyJwt(token: string | undefined | null, secret: string): JwtVerifyResult {
  if (!token || typeof token !== 'string') {
    return { valid: false, reason: 'Token missing' };
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return { valid: false, reason: 'Malformed token' };
  }

  const [encodedHeader, encodedPayload, signature] = parts;
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = computeSignature(signingInput, secret);

  const providedSigBuf = Buffer.from(signature);
  const expectedSigBuf = Buffer.from(expectedSignature);
  const signatureValid =
    providedSigBuf.length === expectedSigBuf.length && timingSafeEqual(providedSigBuf, expectedSigBuf);

  if (!signatureValid) {
    return { valid: false, reason: 'Invalid signature' };
  }

  let payload: JwtPayload;
  try {
    payload = JSON.parse(base64UrlDecode(encodedPayload));
  } catch {
    return { valid: false, reason: 'Invalid payload encoding' };
  }

  if (!payload || typeof payload.sub !== 'string') {
    return { valid: false, reason: 'Missing subject claim' };
  }

  if (typeof payload.exp === 'number' && Math.floor(Date.now() / 1000) >= payload.exp) {
    return { valid: false, reason: 'Token expired' };
  }

  return { valid: true, payload };
}
