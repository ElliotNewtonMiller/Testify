import { describe, it, expect } from 'vitest';
import { signJwt, verifyJwt } from '../src/index.js';

describe('JWT (HMAC-SHA256, dependency-free)', () => {
  it('signs a token and verifies it successfully with the same secret', () => {
    const token = signJwt({ sub: 'usr_abc123', username: 'admin' }, 'test-secret');
    const result = verifyJwt(token, 'test-secret');

    expect(result.valid).toBe(true);
    expect(result.payload?.sub).toBe('usr_abc123');
    expect(result.payload?.username).toBe('admin');
    expect(typeof result.payload?.iat).toBe('number');
    expect(typeof result.payload?.exp).toBe('number');
  });

  it('produces a standard three-segment compact JWT string', () => {
    const token = signJwt({ sub: 'usr_abc123' }, 'test-secret');
    expect(token.split('.')).toHaveLength(3);
  });

  it('rejects a token verified with the wrong secret', () => {
    const token = signJwt({ sub: 'usr_abc123' }, 'correct-secret');
    const result = verifyJwt(token, 'wrong-secret');

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('Invalid signature');
  });

  it('rejects a token that has been tampered with (payload swap without re-signing)', () => {
    const token = signJwt({ sub: 'usr_regular_tester' }, 'test-secret');
    const [header, payload, signature] = token.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ sub: 'usr_admin', iat: 0, exp: 9999999999 }), 'utf8').toString(
      'base64url'
    );
    const forgedToken = `${header}.${forgedPayload}.${signature}`;

    const result = verifyJwt(forgedToken, 'test-secret');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('Invalid signature');
  });

  it('rejects an expired token', () => {
    const token = signJwt({ sub: 'usr_abc123' }, 'test-secret', -10);
    const result = verifyJwt(token, 'test-secret');

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('Token expired');
  });

  it('rejects malformed tokens', () => {
    expect(verifyJwt('not-a-jwt', 'test-secret').valid).toBe(false);
    expect(verifyJwt('', 'test-secret').valid).toBe(false);
    expect(verifyJwt(undefined, 'test-secret').valid).toBe(false);
    expect(verifyJwt('a.b.c', 'test-secret').valid).toBe(false);
  });
});
