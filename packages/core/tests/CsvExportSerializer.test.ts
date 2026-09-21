import { describe, it, expect } from 'vitest';
import { CsvExportSerializer } from '../src/export/CsvExportSerializer.js';
import type { DefinitionsExportBundle, ExecutionResultsExportBundle, ExportableSuite } from '../src/export/types.js';

function makeSuite(overrides: Partial<ExportableSuite> = {}): ExportableSuite {
  return { id: 's1', name: 'Suite A', description: null, position: 0, cases: [], sub_suites: [], ...overrides };
}

function baseBundle(suites: ExportableSuite[]): DefinitionsExportBundle {
  return {
    object: 'definitions_export_bundle',
    exported_at: '2026-09-21T00:00:00.000Z',
    project: { id: 'p1', name: 'Demo', prefix: 'DEM' },
    scope: { type: 'PROJECT' },
    status_filter: 'ALL',
    custom_field_definitions: [],
    suites,
    record_count: { suite_count: suites.length, case_count: suites.reduce((n, s) => n + s.cases.length, 0) },
  };
}

describe('CsvExportSerializer.serializeDefinitions', () => {
  const serializer = new CsvExportSerializer();

  it('emits the exact header row CsvParser.ts recognizes on import', () => {
    const bundle = baseBundle([]);
    const [header] = serializer.serializeDefinitions(bundle).split('\r\n');
    expect(header).toBe('Suite Path,External ID,Title,Summary,Preconditions,Importance,Execution Type,Step Number,Action,Expected Result');
  });

  it('emits one row per step, with case-level fields repeated', () => {
    const suite = makeSuite({
      cases: [
        {
          id: 'c1',
          external_id: 'DEM-1',
          title: 'Case One',
          priority: 'HIGH',
          execution_type: 'MANUAL',
          version: { id: 'v1', version_number: 1, status: 'APPROVED', summary: 'Sum', preconditions: 'Pre' },
          steps: [
            { id: 'st1', step_number: 1, action: 'Do X', expected_result: 'See Y', execution_type: 'MANUAL' },
            { id: 'st2', step_number: 2, action: 'Do Z', expected_result: 'See W', execution_type: 'MANUAL' },
          ],
          custom_field_values: [],
        },
      ],
    });
    const lines = serializer.serializeDefinitions(baseBundle([suite])).split('\r\n');
    expect(lines).toHaveLength(3); // header + 2 step rows
    expect(lines[1]).toBe('Suite A,DEM-1,Case One,Sum,Pre,HIGH,MANUAL,1,Do X,See Y');
    expect(lines[2]).toBe('Suite A,DEM-1,Case One,Sum,Pre,HIGH,MANUAL,2,Do Z,See W');
  });

  it('emits exactly one row (with blank step columns) for a zero-step case', () => {
    const suite = makeSuite({
      cases: [
        {
          id: 'c1',
          external_id: 'DEM-1',
          title: 'No Steps',
          priority: 'LOW',
          execution_type: 'MANUAL',
          version: { id: 'v1', version_number: 1, status: 'DRAFT', summary: null, preconditions: null },
          steps: [],
          custom_field_values: [],
        },
      ],
    });
    const lines = serializer.serializeDefinitions(baseBundle([suite])).split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('Suite A,DEM-1,No Steps,,,LOW,MANUAL,,,');
  });

  it('builds nested Suite Path strings and adds a custom field column per referenced field', () => {
    const child = makeSuite({
      id: 's2',
      name: 'Child',
      cases: [
        {
          id: 'c1',
          external_id: 'DEM-2',
          title: 'Nested Case',
          priority: 'MEDIUM',
          execution_type: 'MANUAL',
          version: { id: 'v1', version_number: 1, status: 'APPROVED', summary: null, preconditions: null },
          steps: [],
          custom_field_values: [{ definition_id: 'cf1', name: 'cf_browser', field_label: 'Browser', field_type: 'TEXT', value: 'Chrome' }],
        },
      ],
    });
    const parent = makeSuite({ sub_suites: [child] });
    const lines = serializer.serializeDefinitions(baseBundle([parent])).split('\r\n');
    expect(lines[0]).toContain('cf_browser');
    expect(lines[1]).toContain('Suite A/Child,DEM-2');
    expect(lines[1].endsWith('Chrome')).toBe(true);
  });

  it('quotes fields containing commas, quotes, or newlines', () => {
    const suite = makeSuite({
      cases: [
        {
          id: 'c1',
          external_id: 'DEM-1',
          title: 'Has, a comma and a "quote"',
          priority: 'LOW',
          execution_type: 'MANUAL',
          version: { id: 'v1', version_number: 1, status: 'APPROVED', summary: null, preconditions: null },
          steps: [],
          custom_field_values: [],
        },
      ],
    });
    const lines = serializer.serializeDefinitions(baseBundle([suite])).split('\r\n');
    expect(lines[1]).toContain('"Has, a comma and a ""quote"""');
  });
});

describe('CsvExportSerializer.serializeExecutionResults', () => {
  const serializer = new CsvExportSerializer();

  it('emits the expected header and one row per step result', () => {
    const bundle: ExecutionResultsExportBundle = {
      object: 'execution_results_export_bundle',
      exported_at: '2026-09-21T00:00:00.000Z',
      project: { id: 'p1', name: 'Demo', prefix: 'DEM' },
      plan: { id: 'pl1', name: 'Plan' },
      build: { id: 'b1', name: 'Build', status: 'OPEN', release_date: null },
      executions: [
        {
          id: 'e1',
          test_case_id: 'c1',
          test_case_external_id: 'DEM-1',
          test_case_title: 'Case',
          test_case_version_id: 'v1',
          test_case_version_number: 1,
          tester_id: 'u1',
          tester_username: 'alice',
          status: 'COMPLETED',
          verdict: 'PASSED',
          execution_duration_ms: 500,
          notes: null,
          execution_timestamp: '2026-09-21T00:00:00.000Z',
          environment_tags: null,
          step_results: [
            { test_step_id: 'st1', step_number: 1, verdict: 'PASSED', actual_result: null },
            { test_step_id: 'st2', step_number: 2, verdict: 'FAILED', actual_result: 'boom' },
          ],
        },
      ],
      record_count: { execution_count: 1 },
    };
    const lines = serializer.serializeExecutionResults(bundle).split('\r\n');
    expect(lines[0]).toBe(
      'Test Case External ID,Test Case Title,Version Number,Tester,Status,Verdict,Duration (ms),Notes,Execution Timestamp,Step Number,Step Verdict,Step Actual Result'
    );
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain('boom');
  });
});
