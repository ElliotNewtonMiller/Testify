import type {
  IFileSerializer,
  DefinitionsExportBundle,
  ExecutionResultsExportBundle,
  ExportableSuite,
  ExportableCase,
} from './types.js';

/** Quote-if-needed CSV field escaping (RFC 4180-ish) -- no existing CSV-writing utility
 * exists in this package yet (csvHelpers.ts is read-side only, for the importer). */
function csvEscape(value: string): string {
  if (value === '') return '';
  if (/[",\n\r]/.test(value)) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

function csvRow(fields: string[]): string {
  return fields.map(csvEscape).join(',');
}

function formatCsvValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.join('; ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

interface FlatDefinitionsRow {
  suitePath: string;
  externalId: string;
  title: string;
  summary: string;
  preconditions: string;
  importance: string;
  executionType: string;
  stepNumber: string;
  action: string;
  expectedResult: string;
  customFieldValues: Record<string, string>;
}

function flattenCase(suitePath: string, tc: ExportableCase, customFieldNames: Set<string>): FlatDefinitionsRow[] {
  const customFieldValues: Record<string, string> = {};
  for (const cfv of tc.custom_field_values) {
    customFieldNames.add(cfv.name);
    customFieldValues[cfv.name] = formatCsvValue(cfv.value);
  }

  const base = {
    suitePath,
    externalId: tc.external_id,
    title: tc.title,
    summary: tc.version.summary || '',
    preconditions: tc.version.preconditions || '',
    importance: tc.priority,
    executionType: tc.execution_type,
    customFieldValues,
  };

  if (tc.steps.length === 0) {
    return [{ ...base, stepNumber: '', action: '', expectedResult: '' }];
  }

  return tc.steps.map((st) => ({
    ...base,
    stepNumber: String(st.step_number),
    action: st.action,
    expectedResult: st.expected_result,
  }));
}

/** Walks the suite tree depth-first, flattening every case into one row per step (case
 * fields repeated), building the "Suite Path" cell the same way CsvParser's importer
 * expects it to look ("Parent/Child/Grandchild"), and collecting every custom field name
 * encountered so the caller can build a stable column set. */
function flattenSuiteTree(suites: ExportableSuite[], parentPath: string, customFieldNames: Set<string>): FlatDefinitionsRow[] {
  const rows: FlatDefinitionsRow[] = [];
  for (const suite of suites) {
    const suitePath = parentPath ? `${parentPath}/${suite.name}` : suite.name;
    for (const tc of suite.cases) {
      rows.push(...flattenCase(suitePath, tc, customFieldNames));
    }
    rows.push(...flattenSuiteTree(suite.sub_suites, suitePath, customFieldNames));
  }
  return rows;
}

/**
 * Emits definitions-export CSV with the exact header set CsvParser.ts's importer already
 * recognizes (Suite Path/External ID/Title/Summary/Preconditions/Importance/Execution
 * Type/Step Number/Action/Expected Result, plus cf_<name> custom-field columns), one row
 * per step with case-level fields repeated -- so this CSV is directly re-importable through
 * the existing importer with no new import-side code.
 *
 * Known, accepted lossiness (documented in CLAUDE.md, not silently worked around since
 * fixing it would mean touching the already-shipped importer):
 *   - Importance: CsvParser folds anything that isn't exactly HIGH/MEDIUM/LOW to MEDIUM on
 *     reimport -- a CRITICAL or P1 priority here will come back as MEDIUM, not a "closest
 *     match".
 *   - A custom field whose name collides with a reserved substring the importer checks
 *     first (title/suite/action/importance/expected/result/...) will be miscategorized as
 *     that built-in column on reimport rather than preserved as a custom field.
 *   - MULTI_SELECT values are joined with "; " for readability but the importer has no
 *     special-case to split a CSV cell back into an array -- multi-select values do not
 *     round-trip via CSV (map to an existing field manually, or use JSON export instead).
 */
export class CsvExportSerializer implements IFileSerializer {
  readonly formatId = 'STANDARD_CSV';
  readonly contentType = 'text/csv';
  readonly fileExtension = 'csv';

  serializeDefinitions(bundle: DefinitionsExportBundle): string {
    const customFieldNames = new Set<string>();
    const rows = flattenSuiteTree(bundle.suites, '', customFieldNames);
    const sortedCfNames = Array.from(customFieldNames).sort();

    const header = [
      'Suite Path',
      'External ID',
      'Title',
      'Summary',
      'Preconditions',
      'Importance',
      'Execution Type',
      'Step Number',
      'Action',
      'Expected Result',
      ...sortedCfNames,
    ];

    const lines = [csvRow(header)];
    for (const row of rows) {
      lines.push(
        csvRow([
          row.suitePath,
          row.externalId,
          row.title,
          row.summary,
          row.preconditions,
          row.importance,
          row.executionType,
          row.stepNumber,
          row.action,
          row.expectedResult,
          ...sortedCfNames.map((name) => row.customFieldValues[name] || ''),
        ])
      );
    }
    return lines.join('\r\n');
  }

  serializeExecutionResults(bundle: ExecutionResultsExportBundle): string {
    const header = [
      'Test Case External ID',
      'Test Case Title',
      'Version Number',
      'Tester',
      'Status',
      'Verdict',
      'Duration (ms)',
      'Notes',
      'Execution Timestamp',
      'Step Number',
      'Step Verdict',
      'Step Actual Result',
    ];
    const lines = [csvRow(header)];

    for (const ex of bundle.executions) {
      const base = [
        ex.test_case_external_id,
        ex.test_case_title,
        String(ex.test_case_version_number),
        ex.tester_username || ex.tester_id,
        ex.status,
        ex.verdict,
        String(ex.execution_duration_ms),
        ex.notes || '',
        ex.execution_timestamp,
      ];
      if (ex.step_results.length === 0) {
        lines.push(csvRow([...base, '', '', '']));
      } else {
        for (const sr of ex.step_results) {
          lines.push(csvRow([...base, String(sr.step_number), sr.verdict, sr.actual_result || '']));
        }
      }
    }
    return lines.join('\r\n');
  }
}
