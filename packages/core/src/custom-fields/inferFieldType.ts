import type { CustomFieldType } from './customFieldValidator.js';

const BOOLISH = new Set(['true', 'false', 'yes', 'no', '1', '0']);

// ISO-ish (2024-01-31, optionally with a time part) or MM/DD/YYYY-ish shapes -- guards
// against Date.parse's over-permissive parsing of plain numbers/short strings by requiring
// the sample to already look date-shaped before trusting Date.parse's verdict.
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}([T ].*)?$|^\d{1,2}\/\d{1,2}\/\d{2,4}$/;

/**
 * Infers the most likely CustomFieldType for an unmapped incoming import column from a
 * small sample of its observed string values (up to 5, collected during the dry-run tree
 * walk in apps/server/src/routes/ingestion.ts). Pure and synchronous -- used to populate
 * UnmappedCustomField.detected_type, and as the default (user-overridable) type for an
 * AUTO_CREATE mapping.
 *
 * Checked in this order (first match wins), against every non-empty sample:
 *   1. CHECKBOX -- checked before NUMBER specifically so a lone "1"/"0" sample infers
 *      boolean rather than number.
 *   2. NUMBER
 *   3. DATE
 *   4. TEXT (default fallback)
 *
 * SINGLE_SELECT/MULTI_SELECT are deliberately never inferred -- a small closed set of
 * repeated values is too weak a signal from a handful of samples and risks false positives
 * on freeform text that happens to repeat; that's always an explicit user choice.
 */
export function inferFieldType(samples: string[]): CustomFieldType {
  const nonEmpty = samples.map((s) => (s ?? '').trim()).filter((s) => s.length > 0);
  if (nonEmpty.length === 0) return 'TEXT';

  if (nonEmpty.every((s) => BOOLISH.has(s.toLowerCase()))) return 'CHECKBOX';

  if (nonEmpty.every((s) => Number.isFinite(Number(s)))) return 'NUMBER';

  if (nonEmpty.every((s) => DATE_SHAPE.test(s) && !Number.isNaN(Date.parse(s)))) return 'DATE';

  return 'TEXT';
}
