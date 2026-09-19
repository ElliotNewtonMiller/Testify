import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { CsvParser } from '../src/ingestion/CsvParser.js';
import type { ParsedSuite } from '../src/ingestion/types.js';

async function parseAll(csv: string): Promise<ParsedSuite[]> {
  const parser = new CsvParser();
  const suites: ParsedSuite[] = [];
  for await (const suite of parser.parseStream(Readable.from([csv]))) {
    suites.push(suite);
  }
  return suites;
}

describe('CsvParser (baseline behavior, pinned before the csvHelpers extraction)', () => {
  it('canHandle matches a .csv filename or a header containing suite/title/action', () => {
    const parser = new CsvParser();
    expect(parser.canHandle(Buffer.from(''), 'cases.csv')).toBe(true);
    expect(parser.canHandle(Buffer.from('Suite Path,Title'), 'data.txt')).toBe(true);
    expect(parser.canHandle(Buffer.from('foo,bar'), 'data.txt')).toBe(false);
  });

  it('parses a single-row-per-case CSV into one suite with one case', async () => {
    const csv = ['Suite Path,Title,External ID,Importance', 'Auth,Login works,TC-1,3'].join('\n');
    const suites = await parseAll(csv);
    expect(suites).toHaveLength(1);
    expect(suites[0].name).toBe('Auth');
    expect(suites[0].test_cases).toHaveLength(1);
    expect(suites[0].test_cases[0]).toMatchObject({ title: 'Login works', external_id: 'TC-1', importance: 'HIGH' });
  });

  it('groups multiple step rows into one case by suitePath::(external_id||title)', async () => {
    const csv = [
      'Suite Path,Title,External ID,Step,Action,Expected',
      'Auth,Login works,TC-2,1,Enter credentials,Sees dashboard',
      'Auth,Login works,TC-2,2,Click submit,Redirected',
    ].join('\n');
    const suites = await parseAll(csv);
    expect(suites[0].test_cases).toHaveLength(1);
    expect(suites[0].test_cases[0].steps).toHaveLength(2);
    expect(suites[0].test_cases[0].steps[1]).toMatchObject({ step_number: 2, actions: 'Click submit', expected_results: 'Redirected' });
  });

  it('builds nested suites from a "/" or ">" separated Suite Path', async () => {
    const csv = ['Suite Path,Title', 'Auth/Login,Case A', 'Auth>Logout,Case B'].join('\n');
    const suites = await parseAll(csv);
    expect(suites).toHaveLength(1);
    expect(suites[0].name).toBe('Auth');
    expect(suites[0].sub_suites.map((s) => s.name).sort()).toEqual(['Login', 'Logout']);
  });

  it('treats unrecognized columns as cf_<slug> custom fields, and honors cf:/customfield: prefixes', async () => {
    const csv = ['Suite Path,Title,Browser,cf:Environment', 'Auth,Case A,Chrome,Staging'].join('\n');
    const suites = await parseAll(csv);
    expect(suites[0].test_cases[0].custom_fields).toEqual({ cf_browser: 'Chrome', cf_environment: 'Staging' });
  });

  it('defaults missing Suite Path/Title to "Default Suite"/"Unnamed Case"', async () => {
    const csv = ['Importance', '2'].join('\n');
    const suites = await parseAll(csv);
    expect(suites[0].name).toBe('Default Suite');
    expect(suites[0].test_cases[0].title).toBe('Unnamed Case');
  });
});
