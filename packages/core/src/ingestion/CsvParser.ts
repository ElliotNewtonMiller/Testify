import type { Readable } from 'node:stream';
import type {
  IFileParser,
  ParseOptions,
  ParsedSuite,
  ParsedCase,
  ParsedStep,
} from './types.js';
import { parseCsvLine, bufferStreamToLines, splitSuitePath, slugifyColumnName } from './csvHelpers.js';
import { restoreNeutralizedFormula } from '../export/spreadsheetFormula.js';

export class CsvParser implements IFileParser {
  readonly formatId = 'STANDARD_CSV';

  canHandle(fileHeader: Buffer, filename: string): boolean {
    if (filename.toLowerCase().endsWith('.csv')) return true;
    const headerStr = fileHeader.toString('utf-8', 0, Math.min(fileHeader.length, 512)).toLowerCase();
    return headerStr.includes('suite') || headerStr.includes('title') || headerStr.includes('action');
  }

  async *parseStream(
    inputStream: Readable | ReadableStream | AsyncIterable<Buffer | string>,
    options?: ParseOptions
  ): AsyncIterable<ParsedSuite> {
    const lines = await bufferStreamToLines(inputStream);

    if (lines.length === 0) return;

    // First non-empty line is header
    const headerLineIdx = lines.findIndex((l) => l.trim().length > 0);
    if (headerLineIdx === -1) return;

    const headers = parseCsvLine(lines[headerLineIdx]).map((h) => h.trim());
    const dataLines = lines.slice(headerLineIdx + 1);

    // Map column indices
    let suitePathIdx = -1;
    let titleIdx = -1;
    let externalIdIdx = -1;
    let summaryIdx = -1;
    let preconditionsIdx = -1;
    let importanceIdx = -1;
    let executionTypeIdx = -1;
    let stepNumIdx = -1;
    let actionIdx = -1;
    let expectedIdx = -1;

    const customFieldCols: Array<{ index: number; key: string }> = [];

    headers.forEach((h, idx) => {
      const lower = h.toLowerCase().replace(/[^a-z0-9_:]/g, '_');
      if (lower.includes('suite_path') || lower.includes('suite')) {
        if (suitePathIdx === -1) suitePathIdx = idx;
      } else if (lower.includes('title') || lower.includes('case_name')) {
        if (titleIdx === -1) titleIdx = idx;
      } else if (lower.includes('external') || lower === 'id') {
        if (externalIdIdx === -1) externalIdIdx = idx;
      } else if (lower.includes('summary')) {
        if (summaryIdx === -1) summaryIdx = idx;
      } else if (lower.includes('precondition')) {
        if (preconditionsIdx === -1) preconditionsIdx = idx;
      } else if (lower.includes('importance')) {
        if (importanceIdx === -1) importanceIdx = idx;
      } else if (lower.includes('execution_type') || lower.includes('exec_type')) {
        if (executionTypeIdx === -1) executionTypeIdx = idx;
      } else if (lower.includes('step_number') || lower === 'step') {
        if (stepNumIdx === -1) stepNumIdx = idx;
      } else if (lower.includes('action')) {
        if (actionIdx === -1) actionIdx = idx;
      } else if (lower.includes('expected') || lower.includes('result')) {
        if (expectedIdx === -1) expectedIdx = idx;
      } else if (h.toLowerCase().startsWith('cf:') || h.toLowerCase().startsWith('customfield:')) {
        const fieldName = h.split(':')[1].trim();
        customFieldCols.push({ index: idx, key: slugifyColumnName(fieldName) });
      } else {
        // Any unknown column is treated as custom field
        customFieldCols.push({ index: idx, key: slugifyColumnName(h) });
      }
    });

    // Root suites map by suite path
    const rootSuitesMap = new Map<string, ParsedSuite>();
    // Case lookup key: suitePath + '::' + (external_id || title)
    const casesMap = new Map<string, ParsedCase>();

    for (const rawLine of dataLines) {
      if (!rawLine.trim()) continue;
      // Undo the apostrophe our CSV export puts before formula-like text, so an export re-imports exactly.
      const row = parseCsvLine(rawLine).map(restoreNeutralizedFormula);

      const suitePath = (suitePathIdx !== -1 ? row[suitePathIdx] : 'Default Suite') || 'Default Suite';
      const title = (titleIdx !== -1 ? row[titleIdx] : 'Unnamed Case') || 'Unnamed Case';
      const externalId = externalIdIdx !== -1 ? row[externalIdIdx]?.trim() : undefined;
      const summary = summaryIdx !== -1 ? row[summaryIdx]?.trim() : '';
      const preconditions = preconditionsIdx !== -1 ? row[preconditionsIdx]?.trim() : '';

      let rawImp = (importanceIdx !== -1 ? row[importanceIdx]?.trim() : '') || options?.defaultImportance || 'MEDIUM';
      if (rawImp === '3') rawImp = 'HIGH';
      if (rawImp === '2') rawImp = 'MEDIUM';
      if (rawImp === '1') rawImp = 'LOW';
      const importance = (['HIGH', 'MEDIUM', 'LOW'].includes(rawImp.toUpperCase()) ? rawImp.toUpperCase() : 'MEDIUM') as any;

      let rawExec = (executionTypeIdx !== -1 ? row[executionTypeIdx]?.trim() : '') || options?.defaultExecutionType || 'MANUAL';
      if (rawExec === '2') rawExec = 'AUTOMATED';
      if (rawExec === '1') rawExec = 'MANUAL';
      const executionType = (rawExec.toUpperCase() === 'AUTOMATED' ? 'AUTOMATED' : 'MANUAL') as any;

      const stepNumStr = stepNumIdx !== -1 ? row[stepNumIdx]?.trim() : '';
      const stepAction = actionIdx !== -1 ? row[actionIdx]?.trim() : '';
      const expectedResult = expectedIdx !== -1 ? row[expectedIdx]?.trim() : '';

      const customFields: Record<string, string> = {};
      for (const cf of customFieldCols) {
        const val = row[cf.index]?.trim();
        if (val) {
          customFields[cf.key] = val;
        }
      }

      // Build or resolve suite path hierarchy (e.g. "Suite A / SubSuite B")
      const suiteSegments = splitSuitePath(suitePath);

      const rootName = suiteSegments[0];
      if (!rootSuitesMap.has(rootName)) {
        rootSuitesMap.set(rootName, {
          name: rootName,
          details: '',
          node_order: 0,
          sub_suites: [],
          test_cases: [],
        });
      }

      let currentSuite = rootSuitesMap.get(rootName)!;
      for (let i = 1; i < suiteSegments.length; i++) {
        const seg = suiteSegments[i];
        let sub = currentSuite.sub_suites.find((s) => s.name === seg);
        if (!sub) {
          sub = {
            name: seg,
            details: '',
            node_order: currentSuite.sub_suites.length,
            sub_suites: [],
            test_cases: [],
          };
          currentSuite.sub_suites.push(sub);
        }
        currentSuite = sub;
      }

      // Case key
      const caseKey = suitePath + '::' + (externalId || title);
      let targetCase = casesMap.get(caseKey);

      if (!targetCase) {
        targetCase = {
          external_id: externalId || undefined,
          title: title.length > 255 ? title.substring(0, 255) : title,
          summary,
          preconditions,
          importance,
          execution_type: executionType,
          steps: [],
          custom_fields: customFields,
        };
        casesMap.set(caseKey, targetCase);
        currentSuite.test_cases.push(targetCase);
      }

      // Add step if present
      if (stepAction || expectedResult) {
        const parsedStepNum = parseInt(stepNumStr, 10);
        const stepNum = !isNaN(parsedStepNum) ? parsedStepNum : targetCase.steps.length + 1;
        targetCase.steps.push({
          step_number: stepNum,
          actions: stepAction,
          expected_results: expectedResult,
          execution_type: executionType,
        });
      }
    }

    for (const suite of rootSuitesMap.values()) {
      yield suite;
    }
  }
}
