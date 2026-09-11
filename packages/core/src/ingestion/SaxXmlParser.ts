import sax from 'sax';
import type { Readable } from 'node:stream';
import type {
  IFileParser,
  ParseOptions,
  ParsedSuite,
  ParsedCase,
  ParsedStep,
} from './types.js';

function cleanHtmlText(html: string): string {
  if (!html) return '';
  let text = html
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
  return text;
}

function mapImportance(val?: string, defaultVal: string = 'MEDIUM'): 'HIGH' | 'MEDIUM' | 'LOW' {
  if (!val) return (defaultVal.toUpperCase() as any) || 'MEDIUM';
  const clean = val.trim();
  if (clean === '1') return 'LOW';
  if (clean === '2') return 'MEDIUM';
  if (clean === '3') return 'HIGH';
  const upper = clean.toUpperCase();
  if (upper === 'HIGH' || upper === 'MEDIUM' || upper === 'LOW') return upper;
  return 'MEDIUM';
}

function mapExecutionType(val?: string, defaultVal: string = 'MANUAL'): 'MANUAL' | 'AUTOMATED' {
  if (!val) return (defaultVal.toUpperCase() as any) || 'MANUAL';
  const clean = val.trim();
  if (clean === '1') return 'MANUAL';
  if (clean === '2') return 'AUTOMATED';
  const upper = clean.toUpperCase();
  if (upper === 'AUTOMATED') return 'AUTOMATED';
  return 'MANUAL';
}

export class SaxXmlParser implements IFileParser {
  readonly formatId = 'TESTLINK_XML';

  canHandle(fileHeader: Buffer, filename: string): boolean {
    if (filename.toLowerCase().endsWith('.xml')) return true;
    const headerStr = fileHeader.toString('utf-8', 0, Math.min(fileHeader.length, 512)).trim();
    return headerStr.startsWith('<?xml') || headerStr.includes('<testsuite') || headerStr.includes('<testsuites');
  }

  async *parseStream(
    inputStream: Readable | ReadableStream | AsyncIterable<Buffer | string>,
    options?: ParseOptions
  ): AsyncIterable<ParsedSuite> {
    const parser = sax.parser(false, { trim: true });

    const rootSuitesQueue: ParsedSuite[] = [];

    // Parser State Stack
    const suiteStack: ParsedSuite[] = [];
    let currentCase: Partial<ParsedCase> | null = null;
    let currentStep: Partial<ParsedStep> | null = null;
    let currentCustomField: { name?: string; value?: string } | null = null;

    let tagStack: string[] = [];
    let textBuffer = '';

    parser.onopentag = (node) => {
      const tagName = node.name.toLowerCase();
      tagStack.push(tagName);
      textBuffer = '';

      const attrName =
        (node.attributes.name || node.attributes.NAME || node.attributes.Name) as string;

      if (tagName === 'testsuite') {
        const suite: ParsedSuite = {
          name: attrName ? attrName.trim() : 'Unnamed Suite',
          details: '',
          node_order: 0,
          sub_suites: [],
          test_cases: [],
        };
        suiteStack.push(suite);
      } else if (tagName === 'testcase') {
        currentCase = {
          title: attrName ? attrName.trim() : 'Unnamed Case',
          summary: '',
          preconditions: '',
          importance: mapImportance(undefined, options?.defaultImportance),
          execution_type: mapExecutionType(undefined, options?.defaultExecutionType),
          steps: [],
          custom_fields: {},
        };
      } else if (tagName === 'step') {
        currentStep = {
          step_number: (currentCase?.steps?.length || 0) + 1,
          actions: '',
          expected_results: '',
          execution_type: 'MANUAL',
        };
      } else if (tagName === 'custom_field') {
        currentCustomField = {};
      }
    };

    parser.ontext = (text) => {
      textBuffer += text;
    };

    parser.oncdata = (cdata) => {
      textBuffer += cdata;
    };

    parser.onclosetag = (tagName) => {
      const name = tagName.toLowerCase();
      const textVal = textBuffer.trim();

      if (currentCustomField) {
        if (name === 'name') {
          currentCustomField.name = textVal;
        } else if (name === 'value') {
          currentCustomField.value = textVal;
        } else if (name === 'custom_field') {
          if (currentCustomField.name && currentCase && currentCase.custom_fields) {
            currentCase.custom_fields[currentCustomField.name] = currentCustomField.value || '';
          }
          currentCustomField = null;
        }
      } else if (currentStep) {
        if (name === 'step_number') {
          const num = parseInt(textVal, 10);
          if (!isNaN(num)) currentStep.step_number = num;
        } else if (name === 'actions') {
          currentStep.actions = cleanHtmlText(textBuffer);
        } else if (name === 'expectedresults') {
          currentStep.expected_results = cleanHtmlText(textBuffer);
        } else if (name === 'execution_type') {
          currentStep.execution_type = mapExecutionType(textVal);
        } else if (name === 'step') {
          if (currentCase && currentCase.steps) {
            currentCase.steps.push(currentStep as ParsedStep);
          }
          currentStep = null;
        }
      } else if (currentCase) {
        if (name === 'externalid') {
          currentCase.external_id = textVal;
        } else if (name === 'summary') {
          currentCase.summary = cleanHtmlText(textBuffer);
        } else if (name === 'preconditions') {
          currentCase.preconditions = cleanHtmlText(textBuffer);
        } else if (name === 'importance') {
          currentCase.importance = mapImportance(textVal, options?.defaultImportance);
        } else if (name === 'execution_type') {
          currentCase.execution_type = mapExecutionType(textVal, options?.defaultExecutionType);
        } else if (name === 'testcase') {
          if (currentCase.title && currentCase.title.length > 255) {
            currentCase.title = currentCase.title.substring(0, 255);
          }
          const parentSuite = suiteStack[suiteStack.length - 1];
          if (parentSuite) {
            parentSuite.test_cases.push(currentCase as ParsedCase);
          }
          currentCase = null;
        }
      } else if (suiteStack.length > 0) {
        const activeSuite = suiteStack[suiteStack.length - 1];
        if (name === 'details') {
          activeSuite.details = cleanHtmlText(textBuffer);
        } else if (name === 'node_order') {
          const order = parseInt(textVal, 10);
          if (!isNaN(order)) activeSuite.node_order = order;
        } else if (name === 'testsuite') {
          const completedSuite = suiteStack.pop()!;
          if (suiteStack.length > 0) {
            suiteStack[suiteStack.length - 1].sub_suites.push(completedSuite);
          } else {
            rootSuitesQueue.push(completedSuite);
          }
        }
      }

      tagStack.pop();
      textBuffer = '';
    };

    // Helper to stream chunks through sax parser
    const processChunk = (chunk: Buffer | string) => {
      parser.write(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
    };

    // Handle different stream formats (Node.js stream or AsyncIterable)
    if (Symbol.asyncIterator in (inputStream as any)) {
      for await (const chunk of inputStream as AsyncIterable<Buffer | string>) {
        processChunk(chunk);
        while (rootSuitesQueue.length > 0) {
          yield rootSuitesQueue.shift()!;
        }
      }
    } else if (typeof (inputStream as any).on === 'function') {
      const stream = inputStream as Readable;
      for await (const chunk of stream) {
        processChunk(chunk);
        while (rootSuitesQueue.length > 0) {
          yield rootSuitesQueue.shift()!;
        }
      }
    } else {
      processChunk(inputStream as any);
    }

    parser.close();
    while (rootSuitesQueue.length > 0) {
      yield rootSuitesQueue.shift()!;
    }
  }
}
