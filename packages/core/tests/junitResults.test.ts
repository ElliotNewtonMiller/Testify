import { describe, it, expect } from 'vitest';
import { parseJUnitResults, junitCaseId, junitSuiteName, JUnitResultsError } from '../src/ingestion/junitResults.js';

describe('parseJUnitResults', () => {
  it('reads every outcome, durations, messages and stack traces, in file order', () => {
    const tests = parseJUnitResults(`<?xml version="1.0" encoding="UTF-8"?>
      <testsuites>
        <testsuite name="Login" tests="4">
          <properties><property name="os" value="linux"/></properties>
          <testcase classname="com.shop.LoginTest" name="SHOP-101 logs in" time="1.234"/>
          <testcase classname="com.shop.LoginTest" name="rejects a bad password" time="0.5">
            <failure message="expected 401" type="AssertionError">AssertionError: expected 401
    at LoginTest.java:42</failure>
          </testcase>
          <testcase classname="com.shop.LoginTest" name="crashes" time="x"><error><![CDATA[NullPointerException
    at Foo.java:1]]></error></testcase>
          <testcase classname="com.shop.LoginTest" name="later"><skipped message="not today"/></testcase>
        </testsuite>
      </testsuites>`);
    expect(tests.map((t) => [t.name, t.outcome, t.duration_ms])).toEqual([
      ['SHOP-101 logs in', 'PASSED', 1234],
      ['rejects a bad password', 'FAILED', 500],
      ['crashes', 'ERROR', null],
      ['later', 'SKIPPED', null],
    ]);
    expect(tests[1]).toMatchObject({ suite: 'Login', classname: 'com.shop.LoginTest', message: 'expected 401' });
    expect(tests[1].details).toContain('LoginTest.java:42');
    // No message attribute: the first line of the text.
    expect(tests[2].message).toBe('NullPointerException');
    expect(tests[3].message).toBe('not today');
    // Suite properties aren't the test's.
    expect(tests[0].properties).toEqual({});
  });

  it('handles nested suites, a single root suite, test properties and reruns', () => {
    const tests = parseJUnitResults(`<testsuite name="all">
        <testsuite name="inner">
          <testcase name="a"><properties><property name="testify_id" value="SHOP-7"/></properties></testcase>
        </testsuite>
        <testcase name="b"><flakyFailure message="first try failed"/></testcase>
      </testsuite>`);
    expect(tests.map((t) => [t.suite, t.name, t.outcome])).toEqual([
      ['inner', 'a', 'PASSED'],
      ['all', 'b', 'PASSED'],
    ]);
    expect(tests[0].properties).toEqual({ testify_id: 'SHOP-7' });
  });

  it('refuses what is not a JUnit report', () => {
    expect(() => parseJUnitResults('<html><body/></html>')).toThrow(JUnitResultsError);
    expect(() => parseJUnitResults('<testsuite><testcase name="a">')).toThrow(/Not valid XML/);
    expect(() => parseJUnitResults('{"results": []}')).toThrow(JUnitResultsError);
    expect(parseJUnitResults('<testsuites/>')).toEqual([]);
  });
});

describe('matching a JUnit test to a case', () => {
  const test = (name: string, extra: object = {}) => ({ suite: 'S', classname: '', name, outcome: 'PASSED' as const, duration_ms: null, message: null, details: null, properties: {}, ...extra });

  it('takes a readable id from a testify_id property, then from the name', () => {
    expect(junitCaseId(test('logs in', { properties: { testify_id: 'SHOP-9' } }))).toBe('SHOP-9');
    expect(junitCaseId(test('SHOP-101 logs in'))).toBe('SHOP-101');
    expect(junitCaseId(test('[SHOP-101] logs in'))).toBe('SHOP-101');
    expect(junitCaseId(test('logs in (QA2-15)'))).toBe('QA2-15');
    expect(junitCaseId(test('test_shop_101'))).toBeNull();
    expect(junitCaseId(test('SHOP-101x'))).toBeNull();
    expect(junitCaseId(test('logs in'))).toBeNull();
  });

  it('names the suite a JUnit import would have used', () => {
    expect(junitSuiteName(test('a', { classname: 'com.shop.LoginTest' }))).toBe('LoginTest');
    expect(junitSuiteName(test('a'))).toBe('S');
  });
});
