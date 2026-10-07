export const MAX_RECIPIENTS = 50;

// Deliberately simple: one @, no spaces, a dot in the domain. Mail servers do the real check.
const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

export function isValidEmail(address: string): boolean {
  return EMAIL_RE.test(address) && address.length <= 254;
}

/**
 * Recipients from free text or a list: split on commas, semicolons, spaces and new lines,
 * lower-cased and de-duplicated. Returns the bad entries rather than dropping them silently.
 */
export function parseRecipients(input: string | string[]): { recipients: string[]; invalid: string[]; tooMany: boolean } {
  const raw = (Array.isArray(input) ? input.join('\n') : input).split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  const recipients: string[] = [];
  const invalid: string[] = [];
  for (const entry of raw) {
    const address = entry.toLowerCase();
    if (!isValidEmail(address)) invalid.push(entry);
    else if (!recipients.includes(address)) recipients.push(address);
  }
  return { recipients, invalid, tooMany: recipients.length > MAX_RECIPIENTS };
}
