import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { SaxXmlParser, JsonSchemaParser, CsvParser } from '../src/index.js';

describe('Core Ingestion Parsers', () => {
  it('SaxXmlParser parses TestLink XML streaming payload', async () => {
    const xmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="Auth Suite">
    <details><![CDATA[<p>Authentication details</p>]]></details>
    <node_order><![CDATA[1]]></node_order>
    <testcase name="Verify Login">
      <externalid><![CDATA[TC-AUTH-1]]></externalid>
      <summary><![CDATA[User login verification]]></summary>
      <preconditions><![CDATA[User registered]]></preconditions>
      <importance><![CDATA[3]]></importance>
      <execution_type><![CDATA[2]]></execution_type>
      <steps>
        <step>
          <step_number><![CDATA[1]]></step_number>
          <actions><![CDATA[Enter credentials]]></actions>
          <expectedresults><![CDATA[Redirect to dashboard]]></expectedresults>
        </step>
      </steps>
      <custom_fields>
        <custom_field>
          <name><![CDATA[cf_browser]]></name>
          <value><![CDATA[Chrome]]></value>
        </custom_field>
      </custom_fields>
    </testcase>
  </testsuite>
</testsuites>`;

    const parser = new SaxXmlParser();
    expect(parser.canHandle(Buffer.from(xmlContent), 'test.xml')).toBe(true);

    const stream = Readable.from([xmlContent]);
    const suites = [];
    for await (const suite of parser.parseStream(stream)) {
      suites.push(suite);
    }

    expect(suites.length).toBe(1);
    expect(suites[0].name).toBe('Auth Suite');
    expect(suites[0].details).toBe('Authentication details');
    expect(suites[0].test_cases.length).toBe(1);
    const tc = suites[0].test_cases[0];
    expect(tc.title).toBe('Verify Login');
    expect(tc.external_id).toBe('TC-AUTH-1');
    expect(tc.importance).toBe('HIGH');
    expect(tc.execution_type).toBe('AUTOMATED');
    expect(tc.steps.length).toBe(1);
    expect(tc.steps[0].actions).toBe('Enter credentials');
    expect(tc.custom_fields.cf_browser).toBe('Chrome');
  });

  it('JsonSchemaParser parses Native JSON payload', async () => {
    const jsonContent = JSON.stringify([
      {
        name: 'Payment Suite',
        details: 'Stripe integration',
        node_order: 2,
        test_cases: [
          {
            title: 'Stripe 3DS',
            external_id: 'TC-PAY-1',
            importance: 'HIGH',
            execution_type: 'AUTOMATED',
            steps: [{ step_number: 1, actions: 'Click pay', expected_results: 'Challenge popup' }],
            custom_fields: { cf_gateway: 'Stripe' },
          },
        ],
      },
    ]);

    const parser = new JsonSchemaParser();
    expect(parser.canHandle(Buffer.from(jsonContent), 'test.json')).toBe(true);

    const stream = Readable.from([jsonContent]);
    const suites = [];
    for await (const suite of parser.parseStream(stream)) {
      suites.push(suite);
    }

    expect(suites.length).toBe(1);
    expect(suites[0].name).toBe('Payment Suite');
    expect(suites[0].test_cases[0].title).toBe('Stripe 3DS');
    expect(suites[0].test_cases[0].custom_fields.cf_gateway).toBe('Stripe');
  });

  it('CsvParser parses CSV tabular payload', async () => {
    const csvContent = `Suite Path,Title,External ID,Summary,Importance,Execution Type,Step Number,Action,Expected Result,CF: Environment
Payments / Checkout,Verify Payment,TC-PAY-2,Summary text,HIGH,AUTOMATED,1,Submit form,Success,Staging
Payments / Checkout,Verify Payment,TC-PAY-2,Summary text,HIGH,AUTOMATED,2,Check DB,Record inserted,Staging`;

    const parser = new CsvParser();
    expect(parser.canHandle(Buffer.from(csvContent), 'test.csv')).toBe(true);

    const stream = Readable.from([csvContent]);
    const suites = [];
    for await (const suite of parser.parseStream(stream)) {
      suites.push(suite);
    }

    expect(suites.length).toBe(1);
    expect(suites[0].name).toBe('Payments');
    expect(suites[0].sub_suites.length).toBe(1);
    expect(suites[0].sub_suites[0].name).toBe('Checkout');
    expect(suites[0].sub_suites[0].test_cases.length).toBe(1);
    const tc = suites[0].sub_suites[0].test_cases[0];
    expect(tc.title).toBe('Verify Payment');
    expect(tc.steps.length).toBe(2);
    expect(tc.custom_fields.cf_environment).toBe('Staging');
  });

  it('SaxXmlParser operates under <64MB heap on simulated large dataset stream', async () => {
    // Generate streaming chunks of XML
    async function* generateLargeXmlStream() {
      yield '<?xml version="1.0" encoding="UTF-8"?><testsuites>';
      for (let i = 0; i < 5000; i++) {
        yield `<testsuite name="Suite ${i}"><testcase name="Case ${i}"><externalid>TC-${i}</externalid><summary>Summary for case ${i}</summary></testcase></testsuite>`;
      }
      yield '</testsuites>';
    }

    const parser = new SaxXmlParser();
    let count = 0;
    const initialHeap = process.memoryUsage().heapUsed;

    for await (const suite of parser.parseStream(generateLargeXmlStream())) {
      count++;
    }

    const finalHeap = process.memoryUsage().heapUsed;
    const heapDiffMb = (finalHeap - initialHeap) / (1024 * 1024);

    expect(count).toBe(5000);
    expect(heapDiffMb).toBeLessThan(64);
  });
});
