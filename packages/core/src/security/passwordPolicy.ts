export interface PasswordValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Enforces Testify Password Complexity Policy:
 * 1. Total length must be between 8 and 100 characters.
 * 2. Passwords between 8 and 15 characters MUST contain:
 *    - At least one digit (0-9)
 *    - At least one uppercase letter (A-Z)
 *    - At least one symbol (!@#$%^&*()_+-=[]{}|;:,.<>?)
 * 3. Passwords of 16 to 100 characters have NO character type requirements.
 */
export function validatePasswordPolicy(password: string): PasswordValidationResult {
  if (!password || password.length < 8) {
    return { valid: false, reason: 'Password must be at least 8 characters long.' };
  }

  if (password.length > 100) {
    return { valid: false, reason: 'Password cannot exceed 100 characters.' };
  }

  // Passphrase exemption for length >= 16
  if (password.length >= 16) {
    return { valid: true };
  }

  // Requirements for 8-15 character passwords
  const hasDigit = /\d/.test(password);
  const hasUpper = /[A-Z]/.test(password);
  const hasSymbol = /[!@#$%^&*()_+\-=\[\]{}|;:,.<>?\/\\~`]/.test(password);

  if (!hasDigit) {
    return { valid: false, reason: 'Passwords under 16 characters must contain at least one number (0-9).' };
  }

  if (!hasUpper) {
    return { valid: false, reason: 'Passwords under 16 characters must contain at least one uppercase letter (A-Z).' };
  }

  if (!hasSymbol) {
    return { valid: false, reason: 'Passwords under 16 characters must contain at least one symbol (!@#$%^&*...).' };
  }

  return { valid: true };
}
