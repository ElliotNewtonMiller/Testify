import type { Readable } from 'node:stream';
import type {
  IFileParser,
  ParseOptions,
  ParsedSuite,
  ParsedCase,
  ParsedStep,
} from './types.js';

export class JsonSchemaParser implements IFileParser {
  readonly formatId = 'NATIVE_JSON';

  canHandle(fileHeader: Buffer, filename: string): boolean {
    if (filename.toLowerCase().endsWith('.json')) return true;
    const headerStr = fileHeader.toString('utf-8', 0, Math.min(fileHeader.length, 512)).trim();
    return headerStr.startsWith('{') || headerStr.startsWith('[');
  }

  async *parseStream(
    inputStream: Readable | ReadableStream | AsyncIterable<Buffer | string>,
    options?: ParseOptions
  ): AsyncIterable<ParsedSuite> {
    const chunks: string[] = [];
    if (Symbol.asyncIterator in (inputStream as any)) {
      for await (const chunk of inputStream as AsyncIterable<Buffer | string>) {
        chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
      }
    } else {
      const stream = inputStream as Readable;
      for await (const chunk of stream) {
        chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
      }
    }

    const fullContent = chunks.join('');
    if (!fullContent.trim()) return;

    let parsed: any;
    try {
      parsed = JSON.parse(fullContent);
    } catch (e) {
      throw new Error(`Failed to parse JSON schema: ${(e as Error).message}`);
    }

    let rawSuites: any[] = [];
    if (Array.isArray(parsed)) {
      rawSuites = parsed;
    } else if (parsed && Array.isArray(parsed.suites)) {
      rawSuites = parsed.suites;
    } else if (parsed && typeof parsed === 'object' && parsed.name) {
      rawSuites = [parsed];
    }

    for (const rawSuite of rawSuites) {
      yield this.normalizeSuite(rawSuite, options);
    }
  }

  private normalizeSuite(raw: any, options?: ParseOptions): ParsedSuite {
    const subSuites = Array.isArray(raw.sub_suites)
      ? raw.sub_suites.map((s: any) => this.normalizeSuite(s, options))
      : [];

    const testCases = Array.isArray(raw.test_cases)
      ? raw.test_cases.map((c: any) => this.normalizeCase(c, options))
      : [];

    return {
      name: (raw.name || 'Unnamed Suite').trim(),
      details: raw.details || '',
      node_order: typeof raw.node_order === 'number' ? raw.node_order : 0,
      sub_suites: subSuites,
      test_cases: testCases,
    };
  }

  private normalizeCase(raw: any, options?: ParseOptions): ParsedCase {
    const steps = Array.isArray(raw.steps)
      ? raw.steps.map((st: any, idx: number) => ({
          step_number: typeof st.step_number === 'number' ? st.step_number : idx + 1,
          actions: st.actions || st.action || '',
          expected_results: st.expected_results || st.expected_result || st.expected || '',
          execution_type: (st.execution_type || 'MANUAL').toUpperCase() === 'AUTOMATED' ? 'AUTOMATED' : 'MANUAL',
        }))
      : [];

    const rawImportance = (raw.importance || options?.defaultImportance || 'MEDIUM').toString().toUpperCase();
    const importance = rawImportance === 'HIGH' || rawImportance === 'LOW' ? rawImportance : 'MEDIUM';

    const rawExecType = (raw.execution_type || options?.defaultExecutionType || 'MANUAL').toString().toUpperCase();
    const executionType = rawExecType === 'AUTOMATED' ? 'AUTOMATED' : 'MANUAL';

    const customFields: Record<string, string> = {};
    if (raw.custom_fields && typeof raw.custom_fields === 'object') {
      for (const [k, v] of Object.entries(raw.custom_fields)) {
        customFields[k] = String(v ?? '');
      }
    }

    let title = (raw.title || raw.name || 'Unnamed Case').trim();
    if (title.length > 255) {
      title = title.substring(0, 255);
    }

    return {
      external_id: raw.external_id || raw.externalid || undefined,
      title,
      summary: raw.summary || '',
      preconditions: raw.preconditions || '',
      importance: importance as any,
      execution_type: executionType as any,
      steps: steps as ParsedStep[],
      custom_fields: customFields,
    };
  }
}
