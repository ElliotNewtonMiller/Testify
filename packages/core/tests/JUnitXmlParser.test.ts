import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { JUnitXmlParser } from '../src/ingestion/JUnitXmlParser.js';
import type { ParsedSuite } from '../src/ingestion/types.js';

async function parseAll(xml: string): Promise<ParsedSuite[]> {
  const parser = new JUnitXmlParser();
  const suites: ParsedSuite[] = [];
  for await (const suite of parser.parseStream(Readable.from([xml]))) {
    suites.push(suite);
  }
  return suites;
}

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="LoginTests" tests="3">
    <testcase classname="com.acme.LoginTest" name="testValidLogin" time="0.42" />
    <testcase classname="com.acme.LoginTest" name="testInvalidPassword" time="0.10">
      <failure message="Expected 401 but got 200">Assertion failed</failure>
    </testcase>
    <testcase classname="com.acme.LogoutTest" name="testLogout" time="0.05">
      <skipped />
    </testcase>
  </testsuite>
</testsuites>`;

describe('JUnitXmlParser', () => {
  it('canHandle recognizes JUnit XML via tests=/classname= attributes, distinct from TestLink XML', () => {
    const parser = new JUnitXmlParser();
    expect(parser.canHandle(Buffer.from(SAMPLE), 'results.xml')).toBe(true);

    const testLinkXml = '<?xml version="1.0"?><testsuites><testsuite name="Suite"><testcase name="Case"><externalid>TC-1</externalid></testcase></testsuite></testsuites>';
    expect(parser.canHandle(Buffer.from(testLinkXml), 'results.xml')).toBe(false);
  });

  it('nests testcases by full dotted classname under the <testsuite>', async () => {
    const suites = await parseAll(SAMPLE);
    expect(suites).toHaveLength(1);
    expect(suites[0].name).toBe('LoginTests');

    // com.acme.LoginTest -> com / acme / LoginTest, three nested levels
    const com = suites[0].sub_suites.find((s) => s.name === 'com');
    expect(com).toBeDefined();
    const acme = com!.sub_suites.find((s) => s.name === 'acme');
    expect(acme).toBeDefined();
    const loginTest = acme!.sub_suites.find((s) => s.name === 'LoginTest');
    const logoutTest = acme!.sub_suites.find((s) => s.name === 'LogoutTest');
    expect(loginTest?.test_cases).toHaveLength(2);
    expect(logoutTest?.test_cases).toHaveLength(1);
  });

  it('marks every case AUTOMATED with a single synthetic step', async () => {
    const suites = await parseAll(SAMPLE);
    const allCases = suites.flatMap((s) => s.sub_suites.flatMap((c) => c.sub_suites.flatMap((cc) => cc.test_cases)));
    for (const tc of allCases) {
      expect(tc.execution_type).toBe('AUTOMATED');
      expect(tc.steps).toHaveLength(1);
      expect(tc.steps[0]).toMatchObject({ actions: 'Automated test execution', expected_results: 'Test passes' });
    }
  });

  it('derives junit_status/junit_duration_seconds/junit_failure_message from outcome tags', async () => {
    const suites = await parseAll(SAMPLE);
    const com = suites[0].sub_suites.find((s) => s.name === 'com')!;
    const acme = com.sub_suites.find((s) => s.name === 'acme')!;
    const loginTest = acme.sub_suites.find((s) => s.name === 'LoginTest')!;
    const logoutTest = acme.sub_suites.find((s) => s.name === 'LogoutTest')!;

    const passing = loginTest.test_cases.find((c) => c.title === 'testValidLogin')!;
    expect(passing.custom_fields.junit_status).toBe('PASSED');
    expect(passing.custom_fields.junit_duration_seconds).toBe('0.42');
    expect(passing.custom_fields.junit_failure_message).toBeUndefined();

    const failing = loginTest.test_cases.find((c) => c.title === 'testInvalidPassword')!;
    expect(failing.custom_fields.junit_status).toBe('FAILED');
    expect(failing.custom_fields.junit_failure_message).toBe('Expected 401 but got 200');

    const skipped = logoutTest.test_cases.find((c) => c.title === 'testLogout')!;
    expect(skipped.custom_fields.junit_status).toBe('SKIPPED');
  });

  it('treats a bare <testsuite> with no <testsuites> wrapper the same way', async () => {
    const bare = `<testsuite name="Solo" tests="1"><testcase classname="pkg.T" name="works" time="0.01" /></testsuite>`;
    const suites = await parseAll(bare);
    expect(suites).toHaveLength(1);
    expect(suites[0].name).toBe('Solo');
  });
});
