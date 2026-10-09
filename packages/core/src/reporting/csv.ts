import { neutralizeSpreadsheetFormula } from '../export/spreadsheetFormula.js';

function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  // Numbers are written as-is; text that would run as a spreadsheet formula gets an apostrophe.
  const s = typeof v === 'object' ? JSON.stringify(v) : typeof v === 'string' ? neutralizeSpreadsheetFormula(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** RFC 4180 CSV with a header row; objects/arrays in cells are written as JSON, and text that
 * would run as a spreadsheet formula is neutralized (see spreadsheetFormula.ts). */
export function toCsv(columns: string[], rows: Array<Record<string, unknown>>): string {
  const lines = [columns.map(cell).join(',')];
  for (const row of rows) lines.push(columns.map((c) => cell(row[c])).join(','));
  return lines.join('\r\n') + '\r\n';
}
