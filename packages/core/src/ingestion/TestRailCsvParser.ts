import type { Readable } from 'node:stream';
import type {
  IFileParser,
  ParseOptions,
  ParsedSuite,
  ParsedCase,
  ParsedStep,
} from './types.js';
import { bufferStreamToText, parseCsvText, splitSuitePath, slugifyColumnName } from './csvHelpers.js';

const PRIORITY_MAP: Record<string, 'HIGH' | 'MEDIUM' | 'LOW'> = {
  '1 - low': 'LOW',
  low: 'LOW',
  '2 - medium': 'MEDIUM',
  medium: 'MEDIUM',
  '3 - high': 'HIGH',
  high: 'HIGH',
  '4 - critical': 'HIGH', // No 4th priority level in Testify -- Critical folds into HIGH.
  critical: 'HIGH',
};

function foldPriority(raw: string | undefined): 'HIGH' | 'MEDIUM' | 'LOW' {
  if (!raw) return 'MEDIUM';
  return PRIORITY_MAP[raw.trim().toLowerCase()] ?? 'MEDIUM';
}

/** Splits TestRail's numbered-list step/expected-result text ("1. Do X\n2. Do Y") into
 * one entry per detected line; falls back to plain newline-splitting if no numbering is
 * present. */
function splitNumberedLines(raw: string): string[] {
  if (!raw) return [];
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.map((l) => l.replace(/^\d+\.\s*/, ''));
}

/**
 * Parses TestRail's common "combined-column" CSV export shape: one row per case, a single
 * Steps column paired with a single Expected Result column (both numbered-list text).
 *
 * v1 limitation, deliberate: the "indexed-column" export variant (`Steps (Step 1)`,
 * `Steps (Expected Result 1)`, `Steps (Step 2)`, ...) is not handled -- such columns are
 * surfaced as an UNSUPPORTED_TESTRAIL_COLUMN_FORMAT warning by the caller's dry-run pass
 * rather than being silently mis-parsed as generic custom fields (see
 * apps/server/src/routes/ingestion.ts).
 */
export class TestRailCsvParser implements IFileParser {
  readonly formatId = 'TESTRAIL_CSV';

  // Always requires explicit format selection -- TestRail's header set can plausibly
  // collide with the generic STANDARD_CSV fuzzy matcher, and there's no live sample to
  // verify safe auto-detection against.
  canHandle(): boolean {
    return false;
  }

  async *parseStream(
    inputStream: Readable | ReadableStream | AsyncIterable<Buffer | string>,
    options?: ParseOptions
  ): AsyncIterable<ParsedSuite> {
    const text = await bufferStreamToText(inputStream);
    const rows = parseCsvText(text);
    if (rows.length === 0) return;

    const headers = rows[0].map((h) => h.trim());
    const dataRows = rows.slice(1);

    let titleIdx = -1;
    let sectionIdx = -1;
    let idIdx = -1;
    let priorityIdx = -1;
    let preconditionsIdx = -1;
    let stepsIdx = -1;
    let expectedIdx = -1;

    const customFieldCols: Array<{ index: number; key: string }> = [];
    let hasIndexedStepColumns = false;

    headers.forEach((h, idx) => {
      const lower = h.toLowerCase();
      if (/^steps\s*\(step\s*\d+\)$/i.test(h) || /^steps\s*\(expected result\s*\d+\)$/i.test(h)) {
        hasIndexedStepColumns = true;
        return; // not mapped to anything -- see UNSUPPORTED_TESTRAIL_COLUMN_FORMAT below
      }
      if (lower === 'title') {
        if (titleIdx === -1) titleIdx = idx;
      } else if (lower === 'section' || lower === 'section hierarchy') {
        if (sectionIdx === -1) sectionIdx = idx;
      } else if (lower === 'id' || lower === 'case id') {
        if (idIdx === -1) idIdx = idx;
      } else if (lower === 'priority') {
        if (priorityIdx === -1) priorityIdx = idx;
      } else if (lower === 'preconditions' || lower === 'precondition') {
        if (preconditionsIdx === -1) preconditionsIdx = idx;
      } else if (lower === 'steps') {
        if (stepsIdx === -1) stepsIdx = idx;
      } else if (lower === 'expected result' || lower === 'expected results') {
        if (expectedIdx === -1) expectedIdx = idx;
      } else {
        customFieldCols.push({ index: idx, key: slugifyColumnName(h) });
      }
    });

    const rootSuitesMap = new Map<string, ParsedSuite>();

    for (const row of dataRows) {
      const title = (titleIdx !== -1 ? row[titleIdx] : 'Unnamed Case') || 'Unnamed Case';
      const section = sectionIdx !== -1 ? row[sectionIdx] : '';
      const externalId = idIdx !== -1 ? row[idIdx]?.trim() : undefined;
      const priority = foldPriority(priorityIdx !== -1 ? row[priorityIdx] : undefined);
      const preconditions = preconditionsIdx !== -1 ? row[preconditionsIdx]?.trim() : '';

      const customFields: Record<string, string> = {};
      for (const cf of customFieldCols) {
        const val = row[cf.index]?.trim();
        if (val) customFields[cf.key] = val;
      }
      const parserWarnings: string[] = [];
      if (hasIndexedStepColumns) {
        parserWarnings.push('UNSUPPORTED_TESTRAIL_COLUMN_FORMAT');
      }

      const stepsLines = splitNumberedLines(stepsIdx !== -1 ? row[stepsIdx] || '' : '');
      const expectedLines = splitNumberedLines(expectedIdx !== -1 ? row[expectedIdx] || '' : '');

      const steps: ParsedStep[] = [];
      if (stepsLines.length > 0) {
        const misaligned = expectedLines.length > 0 && expectedLines.length !== stepsLines.length;
        for (let i = 0; i < stepsLines.length; i++) {
          steps.push({
            step_number: i + 1,
            actions: stepsLines[i],
            expected_results: misaligned
              ? i === 0
                ? expectedLines.join('\n')
                : ''
              : expectedLines[i] || '',
            execution_type: 'MANUAL',
          });
        }
        if (misaligned) {
          parserWarnings.push('STEP_EXPECTED_MISALIGNED');
        }
      }

      const suiteSegments = splitSuitePath(section);
      const rootName = suiteSegments[0];
      if (!rootSuitesMap.has(rootName)) {
        rootSuitesMap.set(rootName, { name: rootName, details: '', node_order: 0, sub_suites: [], test_cases: [] });
      }
      let currentSuite = rootSuitesMap.get(rootName)!;
      for (let i = 1; i < suiteSegments.length; i++) {
        const seg = suiteSegments[i];
        let sub = currentSuite.sub_suites.find((s) => s.name === seg);
        if (!sub) {
          sub = { name: seg, details: '', node_order: currentSuite.sub_suites.length, sub_suites: [], test_cases: [] };
          currentSuite.sub_suites.push(sub);
        }
        currentSuite = sub;
      }

      currentSuite.test_cases.push({
        external_id: externalId || undefined,
        title: title.length > 255 ? title.substring(0, 255) : title,
        summary: '',
        preconditions,
        importance: priority,
        execution_type: 'MANUAL',
        steps,
        custom_fields: customFields,
        ...(parserWarnings.length > 0 ? { parser_warnings: parserWarnings } : {}),
      });
    }

    for (const suite of rootSuitesMap.values()) {
      yield suite;
    }
  }
}
