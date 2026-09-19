import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { parseCsvLine, bufferStreamToLines, splitSuitePath, slugifyColumnName } from '../src/ingestion/csvHelpers.js';

describe('parseCsvLine', () => {
  it('splits a plain comma-separated line', () => {
    expect(parseCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('handles a quoted field containing a comma', () => {
    expect(parseCsvLine('a,"b,c",d')).toEqual(['a', 'b,c', 'd']);
  });

  it('handles an escaped double-quote inside a quoted field', () => {
    expect(parseCsvLine('a,"say ""hi""",c')).toEqual(['a', 'say "hi"', 'c']);
  });

  it('returns a single-element array for an empty line', () => {
    expect(parseCsvLine('')).toEqual(['']);
  });
});

describe('bufferStreamToLines', () => {
  it('splits a Node Readable into lines, handling \\r\\n and \\n', async () => {
    const stream = Readable.from(['line1\r\nline2\n', 'line3']);
    expect(await bufferStreamToLines(stream)).toEqual(['line1', 'line2', 'line3']);
  });

  it('handles an AsyncIterable input', async () => {
    async function* gen() {
      yield 'a,b\n';
      yield 'c,d';
    }
    expect(await bufferStreamToLines(gen())).toEqual(['a,b', 'c,d']);
  });

  it('drops a trailing all-whitespace remainder', async () => {
    const stream = Readable.from(['a\nb\n   ']);
    expect(await bufferStreamToLines(stream)).toEqual(['a', 'b']);
  });
});

describe('splitSuitePath', () => {
  it('splits on "/"', () => {
    expect(splitSuitePath('Suite A/SubSuite B')).toEqual(['Suite A', 'SubSuite B']);
  });

  it('splits on ">"', () => {
    expect(splitSuitePath('Suite A>SubSuite B')).toEqual(['Suite A', 'SubSuite B']);
  });

  it('trims whitespace around segments', () => {
    expect(splitSuitePath(' Suite A / SubSuite B ')).toEqual(['Suite A', 'SubSuite B']);
  });

  it('defaults to ["Default Suite"] for an empty/whitespace-only path', () => {
    expect(splitSuitePath('')).toEqual(['Default Suite']);
    expect(splitSuitePath('   ')).toEqual(['Default Suite']);
  });
});

describe('slugifyColumnName', () => {
  it('lowercases and replaces non-alphanumeric characters with underscores', () => {
    expect(slugifyColumnName('Browser Version')).toBe('cf_browser_version');
  });

  it('handles a header that is already slug-like', () => {
    expect(slugifyColumnName('already_slug')).toBe('cf_already_slug');
  });
});
