import sax from 'sax';

/**
 * JUnit XML as test *results* (what CI uploads after a build), as opposed to JUnitXmlParser, which
 * reads the same files as test *cases* to import. Every <testcase> becomes one result, in file order;
 * nested <testsuite>s and a <testsuites> root are fine. Tags this doesn't know (properties of a
 * suite, system-out, Surefire's flakyFailure/rerunFailure, ...) are ignored, so a test that passed
 * on a rerun counts as passed.
 */

export type JUnitOutcome = 'PASSED' | 'FAILED' | 'ERROR' | 'SKIPPED';

export interface JUnitTestResult {
  /** The innermost <testsuite name>, or '' */
  suite: string;
  /** <testcase classname>, e.g. com.shop.LoginTest or tests/test_login.py, or '' */
  classname: string;
  /** <testcase name> */
  name: string;
  outcome: JUnitOutcome;
  /** <testcase time> in milliseconds, or null when missing or not a number */
  duration_ms: number | null;
  /** The failure/error/skipped `message` attribute (or its text when there's no message) */
  message: string | null;
  /** The failure/error text: usually the stack trace */
  details: string | null;
  /** <property name value> inside the <testcase> (e.g. pytest's record_property) */
  properties: Record<string, string>;
}

export class JUnitResultsError extends Error {}

export function parseJUnitResults(xml: string): JUnitTestResult[] {
  const parser = sax.parser(true, { trim: false });
  const suites: string[] = [];
  const results: JUnitTestResult[] = [];
  let sawSuite = false;
  let current: JUnitTestResult | null = null;
  // The outcome element we're inside (failure, error, skipped), whose text we collect.
  let outcomeTag: string | null = null;
  let text = '';
  let error: Error | null = null;

  parser.onerror = (e) => {
    error = e;
    // sax keeps throwing on the same error otherwise.
    (parser as unknown as { error: Error | null }).error = null;
  };
  parser.onopentag = (node) => {
    const tag = node.name.toLowerCase();
    const attr = (k: string) => {
      const v = node.attributes[k] ?? node.attributes[k.toUpperCase()];
      return typeof v === 'string' ? v : undefined;
    };
    if (tag === 'testsuite') {
      sawSuite = true;
      suites.push(attr('name') ?? '');
    } else if (tag === 'testsuites') {
      sawSuite = true;
    } else if (tag === 'testcase') {
      const seconds = Number(attr('time'));
      current = {
        suite: suites[suites.length - 1] ?? '',
        classname: (attr('classname') ?? '').trim(),
        name: (attr('name') ?? '').trim(),
        outcome: 'PASSED',
        duration_ms: attr('time') !== undefined && Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null,
        message: null,
        details: null,
        properties: {},
      };
    } else if (current && !outcomeTag && (tag === 'failure' || tag === 'error' || tag === 'skipped')) {
      // The first outcome element decides (failure beats a later skipped, as test runners report it).
      if (current.outcome === 'PASSED') {
        current.outcome = tag === 'failure' ? 'FAILED' : tag === 'error' ? 'ERROR' : 'SKIPPED';
        current.message = attr('message')?.trim() || null;
        outcomeTag = tag;
        text = '';
      }
    } else if (current && tag === 'property') {
      const name = attr('name');
      if (name) current.properties[name] = attr('value') ?? '';
    }
  };
  parser.ontext = (t) => {
    if (outcomeTag) text += t;
  };
  parser.oncdata = (t) => {
    if (outcomeTag) text += t;
  };
  parser.onclosetag = (name) => {
    const tag = name.toLowerCase();
    if (outcomeTag && tag === outcomeTag) {
      const body = text.trim();
      if (current && body) {
        if (!current.message) current.message = body.split('\n')[0].trim();
        current.details = body;
      }
      outcomeTag = null;
    } else if (tag === 'testcase' && current) {
      results.push(current);
      current = null;
    } else if (tag === 'testsuite') {
      suites.pop();
    }
  };

  parser.write(xml).close();
  if (error) throw new JUnitResultsError(`Not valid XML: ${String((error as Error).message).split('\n')[0]}`);
  if (!sawSuite) throw new JUnitResultsError('Not a JUnit XML report: no <testsuite> or <testsuites> element');
  return results;
}

/** Readable case ids look like SHOP-101: a project prefix (a letter, then up to 9 letters or digits), a dash, a number. */
const READABLE_ID = /(?<![A-Za-z0-9-])([A-Z][A-Z0-9]{0,9}-\d+)(?![A-Za-z0-9-])/;

/**
 * The readable case id a test names, if any: a `testify_id` property first (pytest:
 * `record_property("testify_id", "SHOP-101")`), then an id in the test's name (`test_SHOP_101`
 * doesn't count; `SHOP-101 logs in` and `[SHOP-101] logs in` do).
 */
export function junitCaseId(test: JUnitTestResult): string | null {
  const property = test.properties.testify_id?.trim();
  if (property) return property;
  return READABLE_ID.exec(test.name)?.[1] ?? null;
}

/**
 * The suite a JUnit import puts the test in (JUnitXmlParser): the last part of its classname
 * (com.shop.LoginTest → LoginTest), or its <testsuite> when there's no classname.
 */
export function junitSuiteName(test: JUnitTestResult): string {
  const parts = test.classname.split('.').map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : test.suite;
}
