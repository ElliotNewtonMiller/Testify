import { describe, it, expect } from 'vitest';
import { JsonExportSerializer } from '../src/export/JsonExportSerializer.js';
import type { DefinitionsExportBundle, TestResultsExportBundle } from '../src/export/types.js';

const definitionsBundle: DefinitionsExportBundle = {
  object: 'definitions_export_bundle',
  exported_at: '2026-09-21T00:00:00.000Z',
  project: { id: 'proj-1', name: 'Demo', prefix: 'DEM' },
  scope: { type: 'PROJECT' },
  status_filter: 'ALL',
  custom_field_definitions: [{ id: 'cf-1', name: 'browser', field_label: 'Browser', field_type: 'TEXT', options: [] }],
  suites: [
    {
      id: 'suite-1',
      name: 'Suite A',
      description: null,
      position: 0,
      sub_suites: [],
      cases: [
        {
          id: 'case-1',
          external_id: 'DEM-1',
          title: 'Case One',
          priority: 'HIGH',
          execution_type: 'MANUAL',
          version: { id: 'v-1', version_number: 1, status: 'APPROVED', summary: 'S', preconditions: null },
          steps: [{ id: 'step-1', step_number: 1, action: 'Do X', expected_result: 'See Y', execution_type: 'MANUAL' }],
          custom_field_values: [{ definition_id: 'cf-1', name: 'browser', field_label: 'Browser', field_type: 'TEXT', value: 'Chrome' }],
        },
      ],
    },
  ],
  record_count: { suite_count: 1, case_count: 1 },
};

const executionResultsBundle: TestResultsExportBundle = {
  object: 'test_results_export_bundle',
  exported_at: '2026-09-21T00:00:00.000Z',
  project: { id: 'proj-1', name: 'Demo', prefix: 'DEM' },
  plan: { id: 'plan-1', name: 'Plan A' },
  build: { id: 'build-1', name: 'Build 1', status: 'OPEN', release_date: null },
  executions: [
    {
      id: 'exec-1',
      test_case_id: 'case-1',
      test_case_external_id: 'DEM-1',
      test_case_title: 'Case One',
      test_case_version_id: 'v-1',
      test_case_version_number: 1,
      tester_id: 'user-1',
      tester_username: 'alice',
      status: 'COMPLETED',
      verdict: 'PASSED',
      duration_ms: 1234,
      notes: null,
      executed_at: '2026-09-21T00:00:00.000Z',
      environment_tags: { environment: 'staging' },
      step_results: [{ test_step_id: 'step-1', step_number: 1, verdict: 'PASSED', actual_result: null }],
    },
  ],
  record_count: { result_count: 1 },
};

describe('JsonExportSerializer', () => {
  it('serializeDefinitions round-trips a bundle exactly through JSON.parse', () => {
    const serializer = new JsonExportSerializer();
    const result = JSON.parse(serializer.serializeDefinitions(definitionsBundle));
    expect(result).toEqual(definitionsBundle);
  });

  it('serializeTestResults round-trips a bundle exactly through JSON.parse', () => {
    const serializer = new JsonExportSerializer();
    const result = JSON.parse(serializer.serializeTestResults(executionResultsBundle));
    expect(result).toEqual(executionResultsBundle);
  });

  it('reports the expected formatId/contentType/fileExtension', () => {
    const serializer = new JsonExportSerializer();
    expect(serializer.formatId).toBe('NATIVE_JSON');
    expect(serializer.contentType).toBe('application/json');
    expect(serializer.fileExtension).toBe('json');
  });
});
