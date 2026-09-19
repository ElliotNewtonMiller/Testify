import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { TestRailCsvParser } from '../src/ingestion/TestRailCsvParser.js';
import type { ParsedSuite } from '../src/ingestion/types.js';

async function parseAll(csv: string): Promise<ParsedSuite[]> {
  const parser = new TestRailCsvParser();
  const suites: ParsedSuite[] = [];
  for await (const suite of parser.parseStream(Readable.from([csv]))) {
    suites.push(suite);
  }
  return suites;
}

describe('TestRailCsvParser', () => {
  it('canHandle always returns false -- this format requires explicit selection', () => {
    const parser = new TestRailCsvParser();
    expect(parser.canHandle()).toBe(false);
  });

  it('parses Title/Section/Priority/Preconditions/Steps/Expected Result, folding Critical to HIGH', async () => {
    const csv = [
      'ID,Title,Section,Priority,Preconditions,Steps,Expected Result,Type,References',
      'C1,Checkout works,Payments > Checkout,Critical,User is logged in,"1. Add item to cart\n2. Click checkout","1. Item appears in cart\n2. Checkout page loads",Regression,JIRA-42',
    ].join('\n');

    const suites = await parseAll(csv);
    expect(suites).toHaveLength(1);
    expect(suites[0].name).toBe('Payments');
    expect(suites[0].sub_suites).toHaveLength(1);
    expect(suites[0].sub_suites[0].name).toBe('Checkout');

    const tc = suites[0].sub_suites[0].test_cases[0];
    expect(tc.external_id).toBe('C1');
    expect(tc.title).toBe('Checkout works');
    expect(tc.importance).toBe('HIGH'); // Critical folds to HIGH
    expect(tc.preconditions).toBe('User is logged in');
    expect(tc.steps).toHaveLength(2);
    expect(tc.steps[0]).toMatchObject({ actions: 'Add item to cart', expected_results: 'Item appears in cart' });
    expect(tc.steps[1]).toMatchObject({ actions: 'Click checkout', expected_results: 'Checkout page loads' });
    expect(tc.custom_fields).toEqual({ cf_type: 'Regression', cf_references: 'JIRA-42' });
  });

  it('folds every known TestRail priority label onto HIGH/MEDIUM/LOW, defaulting to MEDIUM', async () => {
    const csv = [
      'Title,Priority',
      'A,Low',
      'B,2 - Medium',
      'C,High',
      'D,4 - Critical',
      'E,NotARealPriority',
    ].join('\n');
    const suites = await parseAll(csv);
    const byTitle = Object.fromEntries(suites[0].test_cases.map((c) => [c.title, c.importance]));
    expect(byTitle).toEqual({ A: 'LOW', B: 'MEDIUM', C: 'HIGH', D: 'HIGH', E: 'MEDIUM' });
  });

  it('flags a step/expected line-count mismatch with a STEP_EXPECTED_MISALIGNED parser warning', async () => {
    const csv = ['Title,Steps,Expected Result', 'A,"1. Do X\n2. Do Y","1. Result X"'].join('\n');
    const suites = await parseAll(csv);
    expect(suites[0].test_cases[0].parser_warnings).toContain('STEP_EXPECTED_MISALIGNED');
  });

  it('flags indexed step columns as UNSUPPORTED_TESTRAIL_COLUMN_FORMAT rather than mis-parsing them', async () => {
    const csv = ['Title,Steps (Step 1),Steps (Expected Result 1)', 'A,Do X,Result X'].join('\n');
    const suites = await parseAll(csv);
    expect(suites[0].test_cases[0].parser_warnings).toContain('UNSUPPORTED_TESTRAIL_COLUMN_FORMAT');
    expect(suites[0].test_cases[0].custom_fields).not.toHaveProperty('cf_steps__step_1_');
  });

  it('splits Section hierarchy the same way CsvParser splits Suite Path', async () => {
    const csv = ['Title,Section', 'A,Root > Mid > Leaf'].join('\n');
    const suites = await parseAll(csv);
    expect(suites[0].name).toBe('Root');
    expect(suites[0].sub_suites[0].name).toBe('Mid');
    expect(suites[0].sub_suites[0].sub_suites[0].name).toBe('Leaf');
  });
});
