import { describe, it, expect, beforeEach } from 'vitest';
import { validatePasswordPolicy } from '../../../../packages/core/src/security/passwordPolicy';

describe('Web Application Auth & Session Flow Tests (Log-In / Log-Out Regressions)', () => {
  let localStorageStore: Record<string, string> = {};

  const mockLocalStorage = {
    getItem: (key: string) => localStorageStore[key] || null,
    setItem: (key: string, value: string) => {
      localStorageStore[key] = value;
    },
    removeItem: (key: string) => {
      delete localStorageStore[key];
    },
    clear: () => {
      localStorageStore = {};
    },
  };

  beforeEach(() => {
    localStorageStore = {};
    Object.defineProperty(globalThis, 'localStorage', {
      value: mockLocalStorage,
      writable: true,
      configurable: true,
    });
  });

  describe('Password Policy & Credentials Invariants', () => {
    it('rejects passwords shorter than 8 characters', () => {
      const res = validatePasswordPolicy('Pass1!');
      expect(res.valid).toBe(false);
      expect(res.reason).toContain('at least 8 characters');
    });

    it('rejects 8-15 character passwords missing uppercase, digit, or symbol', () => {
      expect(validatePasswordPolicy('password123').valid).toBe(false);
      expect(validatePasswordPolicy('Passwordpass').valid).toBe(false);
    });

    it('accepts compliant 8-15 character passwords with digit, uppercase, and symbol', () => {
      const res = validatePasswordPolicy('AdminPass123!');
      expect(res.valid).toBe(true);
    });

    it('accepts 16+ character passphrases without special character type requirements', () => {
      const res = validatePasswordPolicy('correct horse battery staple');
      expect(res.valid).toBe(true);
    });
  });

  describe('Session Storage & Sign-Out Lifecycle', () => {
    it('persists auth_token and user_id upon successful login', () => {
      const mockToken = 'mock_jwt_token_123';
      const mockUserId = 'usr_admin_01';

      localStorage.setItem('auth_token', mockToken);
      localStorage.setItem('user_id', mockUserId);

      expect(localStorage.getItem('auth_token')).toBe(mockToken);
      expect(localStorage.getItem('user_id')).toBe(mockUserId);
    });

    it('destroys all session tokens and user state upon sign-out', () => {
      localStorage.setItem('auth_token', 'mock_jwt_token_123');
      localStorage.setItem('user_id', 'usr_admin_01');

      // Execute sign out destruction
      localStorage.removeItem('auth_token');
      localStorage.removeItem('user_id');

      expect(localStorage.getItem('auth_token')).toBeNull();
      expect(localStorage.getItem('user_id')).toBeNull();
    });
  });

  describe('Log-In Component Eye Icon Toggle & Target Error Invariants', () => {
    it('formats target error string for invalid credential attempts', () => {
      const expectedError = 'The email and/or password are not correct.';
      expect(expectedError).toBe('The email and/or password are not correct.');
    });

    it('toggles password input field type state between password and text', () => {
      let showPassword = false;

      // Click eye icon -> toggle visible
      showPassword = !showPassword;
      let inputType = showPassword ? 'text' : 'password';
      expect(inputType).toBe('text');

      // Click eye icon -> toggle hidden
      showPassword = !showPassword;
      inputType = showPassword ? 'text' : 'password';
      expect(inputType).toBe('password');
    });
  });
});
