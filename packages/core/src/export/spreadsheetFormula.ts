/**
 * CSV cells that start with =, +, -, @ (or a tab / carriage return) are run as formulas when the
 * file is opened in Excel, LibreOffice or Google Sheets -- so a test case titled
 * `=HYPERLINK("http://evil.example", "Click")` would become a live link, or worse, in someone's
 * spreadsheet. Prefixing such a cell with an apostrophe makes every one of them show it as text.
 * Plain numbers ("-5", "+3.2") are left alone: they aren't formulas.
 *
 * The native CSV importer undoes it (restoreNeutralizedFormula), so an export re-imports exactly.
 */
const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

export function neutralizeSpreadsheetFormula(value: string): string {
  return FORMULA_START.test(value) && !PLAIN_NUMBER.test(value) ? `'${value}` : value;
}

/** Reverses neutralizeSpreadsheetFormula for a cell read back from a CSV file. */
export function restoreNeutralizedFormula(value: string): string {
  if (value.startsWith("'")) {
    const rest = value.slice(1);
    if (FORMULA_START.test(rest) && !PLAIN_NUMBER.test(rest)) return rest;
  }
  return value;
}
