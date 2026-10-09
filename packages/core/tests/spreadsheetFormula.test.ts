import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { neutralizeSpreadsheetFormula, restoreNeutralizedFormula, CsvExportSerializer, toCsv, CsvParser } from '../src/index.js';

describe('spreadsheet formula neutralizing', () => {
  it('prefixes text that a spreadsheet would run, and leaves plain numbers and ordinary text alone', () => {
    for (const v of ['=1+1', '=HYPERLINK("http://evil.example","x")', '+cmd', '-2+3', '@SUM(A1)', '\tx', '\rx', '-', '=']) {
      expect(neutralizeSpreadsheetFormula(v), v).toBe(`'${v}`);
    }
    for (const v of ['-5', '+3.2', '1e5', '-.5', 'Login works', '', "'already quoted", 'a=b']) {
      expect(neutralizeSpreadsheetFormula(v), v).toBe(v);
    }
  });

  it('restores exactly what it changed', () => {
    for (const v of ['=1+1', '@x', '-2+3', 'plain', '-5', "'leading apostrophe kept"]) {
      expect(restoreNeutralizedFormula(neutralizeSpreadsheetFormula(v))).toBe(v);
    }
  });

  it('report CSVs neutralize text cells but not numbers', () => {
    const csv = toCsv(['title', 'duration'], [{ title: '=HYPERLINK("x")', duration: -3 }]);
    expect(csv.split('\r\n')[1]).toBe(`"'=HYPERLINK(""x"")",-3`);
  });

  it('a definitions export with formula-like text re-imports unchanged', async () => {
    const bundle: any = {
      object: 'definitions_export_bundle',
      exported_at: '2026-10-08T00:00:00.000Z',
      project: { id: 'p', name: 'P', prefix: 'P' },
      scope: { type: 'PROJECT' },
      status_filter: 'ALL',
      custom_field_definitions: [],
      record_count: { suite_count: 1, case_count: 1 },
      suites: [
        {
          id: 's1', name: '=Suite', description: null, position: 0, sub_suites: [],
          cases: [
            {
              id: 'c1', external_id: 'P-1', title: '=HYPERLINK("http://evil.example","Click")', priority: 'HIGH', execution_type: 'MANUAL',
              version: { id: 'v1', version_number: 1, status: 'APPROVED', summary: '@summary', preconditions: '-pre' },
              steps: [{ id: 'st1', step_number: 1, action: '+do it', expected_result: '=2', execution_type: 'MANUAL' }],
              custom_field_values: [],
            },
          ],
        },
      ],
    };
    const csv = new CsvExportSerializer().serializeDefinitions(bundle);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil.example"",""Click"")"`);
    expect(csv).not.toMatch(/(^|,)"?=HYPERLINK/m);

    const suites: any[] = [];
    for await (const suite of new CsvParser().parseStream(Readable.from([csv]))) suites.push(suite);
    const tc = suites[0].test_cases[0];
    expect(suites[0].name).toBe('=Suite');
    expect(tc.title).toBe('=HYPERLINK("http://evil.example","Click")');
    expect(tc.summary).toBe('@summary');
    expect(tc.preconditions).toBe('-pre');
    expect(tc.steps[0]).toMatchObject({ actions: '+do it', expected_results: '=2' });
  });
});
