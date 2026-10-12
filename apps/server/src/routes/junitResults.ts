import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database } from '@testify/db';
import { JUnitResultsError, junitCaseId, junitSuiteName, parseJUnitResults, type BatchResultsRequest, type JUnitTestResult } from '@testify/core';
import { requirePermission } from '../middleware/auth.js';
import { sendError } from '../errors.js';
import { BatchRecorded, recordResultsBatch } from '../services/batchResults.js';
import { findOrCreateRun } from '../services/runByName.js';
import { batchOptions } from './batchExecution.js';
import { junitResultsSchema, planJunitResultsSchema, JUNIT_MAX_TESTS, JUNIT_BODY_LIMIT_BYTES } from '../openapi/areas/projects.js';

/**
 * CI results as a JUnit XML file, the report nearly every test runner writes (pytest --junitxml,
 * Maven Surefire, Gradle, Jest/Vitest junit reporters, go-junit-report, ...). The body is the file
 * itself, any content type: `curl --data-binary @report.xml`.
 *
 * Each <testcase> is matched to a case of the project: by a readable id (a `testify_id` property,
 * or an id like SHOP-101 in the test's name), otherwise by suite name and title, as a JUnit import
 * of the same file would have created them. Matched cases not yet in the plan are added if approved
 * (as for the JSON batch); unmatched tests are reported per item (207) and not recorded.
 */

interface JUnitQuery {
  run_name?: string;
  environment?: string;
  all_or_nothing?: string;
  close_run?: string;
  ci_name?: string;
  ci_run_id?: string;
  ci_job_name?: string;
  ci_url?: string;
  commit_sha?: string;
}

const VERDICT = { PASSED: 'PASSED', FAILED: 'FAILED', ERROR: 'FAILED', SKIPPED: 'SKIPPED' } as const;

/** The JUnit tests as a JSON batch (what services/batchResults.ts records). */
function toBatch(tests: JUnitTestResult[], query: JUnitQuery): BatchResultsRequest {
  return {
    environment: query.environment,
    runner_info: { name: query.ci_name, run_id: query.ci_run_id, job_name: query.ci_job_name, url: query.ci_url, commit_sha: query.commit_sha },
    results: tests.map((t) => {
      const externalId = junitCaseId(t);
      return {
        case_identifier: {
          ...(externalId ? { external_id: externalId } : {}),
          by_path_title: { suite_path: junitSuiteName(t), title: t.name },
        },
        verdict: VERDICT[t.outcome],
        duration_ms: t.duration_ms ?? undefined,
        failure_message: (t.outcome === 'FAILED' || t.outcome === 'ERROR') && t.message ? t.message.slice(0, 2000) : undefined,
        stack_trace: t.outcome === 'SKIPPED' || !t.details ? undefined : t.details.slice(0, 100_000),
        notes: t.outcome === 'ERROR' ? 'The test errored (JUnit <error>) rather than failing an assertion.' : t.outcome === 'SKIPPED' && t.message ? t.message.slice(0, 20_000) : undefined,
      } as BatchResultsRequest['results'][number];
    }),
  };
}

/** How a test is named in the response: classname.name, or just its name. */
const testName = (t: JUnitTestResult) => (t.classname ? `${t.classname}.${t.name}` : t.name);

export async function registerJUnitResultRoutes(app: FastifyInstance, db: Kysely<Database>, jwtSecret: string) {
  // Its own context, so only these routes take a raw body (of any content type).
  await app.register(async (junit) => {
    junit.removeAllContentTypeParsers();
    junit.addContentTypeParser('*', { parseAs: 'string', bodyLimit: JUNIT_BODY_LIMIT_BYTES }, (_req, body, done) => done(null, body));

    const executeRun = requirePermission('EXECUTE_RUN', db, jwtSecret);

    /** The parsed file, or null after answering 400. */
    function readJUnit(req: FastifyRequest, reply: FastifyReply): JUnitTestResult[] | null {
      const xml = typeof req.body === 'string' ? req.body : '';
      let tests: JUnitTestResult[];
      try {
        if (!xml.trim()) throw new JUnitResultsError('The request body is empty: send the JUnit XML file itself, e.g. curl --data-binary @report.xml');
        tests = parseJUnitResults(xml);
      } catch (err) {
        if (!(err instanceof JUnitResultsError)) throw err;
        sendError(reply, 400, err.message, { code: 'INVALID_JUNIT' });
        return null;
      }
      if (tests.length === 0) {
        sendError(reply, 400, 'The JUnit file has no <testcase> elements: nothing to record', { code: 'INVALID_JUNIT' });
        return null;
      }
      if (tests.length > JUNIT_MAX_TESTS) {
        sendError(reply, 400, `The JUnit file has ${tests.length} tests; at most ${JUNIT_MAX_TESTS} can be sent at once. Split it, e.g. one file per test job.`, {
          code: 'INVALID_JUNIT',
        });
        return null;
      }
      return tests;
    }

    async function record(req: FastifyRequest, reply: FastifyReply, runId: string, tests: JUnitTestResult[], extra: object) {
      const options = batchOptions(req, reply);
      if (!options) return reply;
      const outcome = await recordResultsBatch(db, req, reply, req.user!, runId, toBatch(tests, req.query as JUnitQuery), { ...options, maxResults: JUNIT_MAX_TESTS });
      if (!(outcome instanceof BatchRecorded)) return outcome;
      const { payload } = outcome;
      return reply.status(outcome.httpStatus).send({
        ...payload,
        ...extra,
        results: payload.results.map((r) => ({ ...r, test_name: testName(tests[r.index]) })),
      });
    }

    junit.post('/api/v1/runs/:runId/results/junit', { schema: junitResultsSchema, preHandler: executeRun }, async (req, reply) => {
      const tests = readJUnit(req, reply);
      if (!tests) return reply;
      return record(req, reply, (req.params as { runId: string }).runId, tests, {});
    });

    junit.post('/api/v1/plans/:planId/results/junit', { schema: planJunitResultsSchema, preHandler: executeRun }, async (req, reply) => {
      const tests = readJUnit(req, reply);
      if (!tests || !batchOptions(req, reply)) return reply;
      const run = await findOrCreateRun(db, req, reply, req.user!, (req.params as { planId: string }).planId, (req.query as JUnitQuery).run_name);
      if (!run) return reply;
      return record(req, reply, run.id, tests, { run });
    });
  });
}
