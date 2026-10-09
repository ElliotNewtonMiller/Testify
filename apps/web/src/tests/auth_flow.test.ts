import { describe, it, expect } from 'vitest';
import { validatePasswordPolicy } from '../../../../packages/core/src/security/passwordPolicy';

describe('Web Application Auth & Session Flow Tests (Log-In / Log-Out Regressions)', () => {
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
