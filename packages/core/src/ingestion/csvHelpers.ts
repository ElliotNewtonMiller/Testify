import type { Readable } from 'node:stream';

/** Quote-aware single-line CSV field splitter (handles `""`-escaped quotes inside a
 * quoted field). Shared by CsvParser and TestRailCsvParser. */
export function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

/** Buffers an entire input stream (Node Readable | ReadableStream | AsyncIterable) into a
 * flat array of raw text lines, handling \r\n/\n and a trailing partial line. Shared by
 * CsvParser and TestRailCsvParser -- neither format's line-oriented parsing benefits from
 * true streaming the way the XML parsers' SAX-based approach does, so both fully buffer. */
export async function bufferStreamToLines(
  inputStream: Readable | ReadableStream | AsyncIterable<Buffer | string>
): Promise<string[]> {
  const lines: string[] = [];
  let remainder = '';

  const processTextChunk = (chunk: string) => {
    const text = remainder + chunk;
    const splitLines = text.split(/\r?\n/);
    remainder = splitLines.pop() || '';
    lines.push(...splitLines);
  };

  if (Symbol.asyncIterator in (inputStream as any)) {
    for await (const chunk of inputStream as AsyncIterable<Buffer | string>) {
      processTextChunk(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
    }
  } else {
    const stream = inputStream as Readable;
    for await (const chunk of stream) {
      processTextChunk(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
    }
  }
  if (remainder.trim()) {
    lines.push(remainder);
  }

  return lines;
}

/** Buffers an entire input stream into one flat string, with no line-splitting -- the
 * companion to parseCsvText below, which needs the whole text at once to correctly handle
 * a quoted field containing a literal embedded newline (valid CSV per RFC 4180, and common
 * in TestRail's Steps/Expected Result export columns). bufferStreamToLines above splits
 * into lines *before* any quote-awareness is applied, so it cannot handle this case. */
export async function bufferStreamToText(
  inputStream: Readable | ReadableStream | AsyncIterable<Buffer | string>
): Promise<string> {
  let text = '';
  if (Symbol.asyncIterator in (inputStream as any)) {
    for await (const chunk of inputStream as AsyncIterable<Buffer | string>) {
      text += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    }
  } else {
    const stream = inputStream as Readable;
    for await (const chunk of stream) {
      text += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    }
  }
  return text;
}

/** A real, quote-aware CSV tokenizer operating on the whole buffered text at once (not
 * line-by-line), so a quoted field may contain literal commas and newlines. Returns one
 * array of raw field strings per row; a row that is entirely empty fields (a blank line)
 * is dropped. */
export function parseCsvText(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  let sawAnyCharInRow = false;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    if (row.some((f) => f.length > 0)) rows.push(row);
    row = [];
    sawAnyCharInRow = false;
  };

  while (i < text.length) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += char;
      i++;
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      sawAnyCharInRow = true;
      i++;
      continue;
    }
    if (char === ',') {
      endField();
      sawAnyCharInRow = true;
      i++;
      continue;
    }
    if (char === '\r') {
      i++;
      continue;
    }
    if (char === '\n') {
      endRow();
      i++;
      continue;
    }
    field += char;
    sawAnyCharInRow = true;
    i++;
  }
  if (sawAnyCharInRow || field.length > 0) endRow();

  return rows;
}

/** Splits a hierarchy-path string (e.g. a "Suite Path"/"Section" cell) on the common
 * suite-path separators "/" and ">" into trimmed, non-empty segments, defaulting to
 * ["Default Suite"] if nothing usable is found. Shared by CsvParser (its "Suite Path"
 * column) and TestRailCsvParser (its "Section" column, which commonly uses ">" too). */
export function splitSuitePath(raw: string): string[] {
  const segments = (raw || '')
    .split(/[/>]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return segments.length > 0 ? segments : ['Default Suite'];
}

/** Turns an unrecognized column header into the `cf_<slug>` custom-field key both CSV-family
 * parsers use for columns they don't otherwise understand. */
export function slugifyColumnName(header: string): string {
  return 'cf_' + header.toLowerCase().replace(/[^a-z0-9]/g, '_');
}
