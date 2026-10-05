import type { ParsedSuite } from './types.js';

/** Splits one cell of a multi-select column ("UI, API, Slow") into its options -- trimmed,
 * empties dropped, duplicates removed, order kept. */
export function splitMultiSelectValue(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of value.split(',')) {
    const v = part.trim();
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/**
 * The options a new SINGLE_SELECT / MULTI_SELECT field created during import should have:
 * every distinct non-empty value the file holds for that column (case-insensitive key
 * match), in first-seen order. SINGLE_SELECT uses each whole value as one option;
 * MULTI_SELECT splits each value on commas first.
 */
export function collectImportFieldOptions(
  suites: ParsedSuite[],
  incomingKey: string,
  fieldType: 'SINGLE_SELECT' | 'MULTI_SELECT'
): string[] {
  const key = incomingKey.toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (v: string) => {
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  };
  const walk = (list: ParsedSuite[]) => {
    for (const suite of list) {
      for (const tc of suite.test_cases || []) {
        for (const [k, raw] of Object.entries(tc.custom_fields || {})) {
          if (k.toLowerCase() !== key || raw === null || raw === undefined) continue;
          const value = String(raw).trim();
          if (!value) continue;
          if (fieldType === 'MULTI_SELECT') splitMultiSelectValue(value).forEach(add);
          else add(value);
        }
      }
      walk(suite.sub_suites || []);
    }
  };
  walk(suites);
  return out;
}
