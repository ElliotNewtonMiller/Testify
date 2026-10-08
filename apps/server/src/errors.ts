import type { FastifyReply } from 'fastify';

export interface ProblemDetailsOptions {
  type?: string;
  title?: string;
  status?: number;
  code: string;
  detail: string;
  instance?: string;
  invalid_params?: Array<{ name: string; reason: string }>;
}

export function sendProblemDetails(reply: FastifyReply, options: ProblemDetailsOptions) {
  const status = options.status || 422;
  const type = options.type || `https://api.testify.dev/errors/${options.code}`;
  const title = options.title || (status === 422 ? 'Unprocessable Entity' : 'Error');

  reply.header('content-type', 'application/problem+json');
  return reply.status(status).send({
    type,
    title,
    status,
    code: options.code,
    detail: options.detail,
    instance: options.instance,
    invalid_params: options.invalid_params,
    timestamp: new Date().toISOString(),
  });
}

export function sendPlanLockedError(reply: FastifyReply, planId: string, instance?: string) {
  return sendProblemDetails(reply, {
    code: 'PLAN_LOCKED',
    detail: `Test Plan (ID: ${planId}) is locked. Plan specifications and execution states are frozen.`,
    instance,
  });
}

export function sendBuildClosedError(reply: FastifyReply, buildId: string, instance?: string) {
  return sendProblemDetails(reply, {
    code: 'BUILD_CLOSED',
    detail: `Build (ID: ${buildId}) is closed. Executions cannot be added or modified on a closed build.`,
    instance,
    invalid_params: [
      {
        name: 'build_id',
        reason: 'Build status is CLOSED',
      },
    ],
  });
}

export function sendCaseVersionLockedError(reply: FastifyReply, versionId: string, instance?: string) {
  return sendProblemDetails(reply, {
    code: 'CASE_VERSION_LOCKED',
    detail: `Test Case Version (ID: ${versionId}) is approved and locked. Create a new draft version to make changes.`,
    instance,
  });
}

export function sendCaseVersionNotApprovedError(reply: FastifyReply, testCaseId: string, instance?: string) {
  return sendProblemDetails(reply, {
    code: 'CASE_VERSION_NOT_APPROVED',
    detail: `Test Case (ID: ${testCaseId})'s latest version is not APPROVED. Only Approved versions can be linked to a Test Plan unless the project setting "allow_draft_plan_linking" is enabled.`,
    instance,
    invalid_params: [
      {
        name: 'test_case_id',
        reason: 'Latest version status is not APPROVED',
      },
    ],
  });
}

export function sendRequiredCustomFieldsMissingError(
  reply: FastifyReply,
  testCaseId: string,
  missingFieldLabels: string[],
  instance?: string
) {
  return sendProblemDetails(reply, {
    code: 'REQUIRED_CUSTOM_FIELDS_MISSING',
    detail: `Test Case (ID: ${testCaseId}) is missing a value for ${missingFieldLabels.length === 1 ? 'a required custom field' : 'required custom fields'}: ${missingFieldLabels.join(', ')}. Provide ${missingFieldLabels.length === 1 ? 'it' : 'them'} before approving.`,
    instance,
    invalid_params: missingFieldLabels.map((label) => ({
      name: 'custom_field_value',
      reason: `'${label}' is required and has no value or default`,
    })),
  });
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** 409 asking to confirm removing case(s) that already have results (retry with force=true). */
export function sendCaseHasResultsError(
  reply: FastifyReply,
  what: { label: string; scope: 'case' | 'suite'; cases_with_results: number; result_count: number; run_count: number },
  instance?: string
) {
  const subject =
    what.scope === 'case'
      ? `${what.label} has`
      : `${plural(what.cases_with_results, 'case')} in ${what.label} ${what.cases_with_results === 1 ? 'has' : 'have'}`;
  return sendProblemDetails(reply, {
    code: 'CASE_HAS_RESULTS',
    status: 409,
    title: 'Conflict',
    detail:
      `${subject} ${plural(what.result_count, 'result')} in ${plural(what.run_count, 'run')}. ` +
      `Remove ${what.cases_with_results === 1 ? 'it' : 'them'} from this plan anyway? Those results stay in the runs that recorded them; future runs won't include ${what.cases_with_results === 1 ? 'it' : 'them'}.`,
    instance,
    invalid_params: [
      { name: 'cases_with_results', reason: String(what.cases_with_results) },
      { name: 'result_count', reason: String(what.result_count) },
      { name: 'run_count', reason: String(what.run_count) },
    ],
  });
}

/** A result can't be recorded for a case that was removed from the plan. */
export function sendCaseRemovedFromPlanError(reply: FastifyReply, label: string, instance?: string) {
  return sendProblemDetails(reply, {
    code: 'CASE_REMOVED_FROM_PLAN',
    detail: `${label} was removed from this test plan. Its earlier results are kept, but no new results can be recorded for it. Add it back to the plan to test it again.`,
    instance,
  });
}

export function sendSuiteInUseError(
  reply: FastifyReply,
  suiteId: string,
  counts: { subSuites: number; cases: number; planLinks: number; executions: number },
  instance?: string,
  suiteName?: string
) {
  const parts: string[] = [];
  if (counts.subSuites > 0) parts.push(`${counts.subSuites} sub-suite${counts.subSuites === 1 ? '' : 's'}`);
  if (counts.cases > 0) parts.push(`${counts.cases} case${counts.cases === 1 ? '' : 's'}`);
  if (counts.planLinks > 0) parts.push(`${counts.planLinks} plan link${counts.planLinks === 1 ? '' : 's'}`);
  if (counts.executions > 0) parts.push(`${counts.executions} recorded execution${counts.executions === 1 ? '' : 's'}`);

  const suiteRef = suiteName ? suiteName : `(ID: ${suiteId})`;

  return sendProblemDetails(reply, {
    code: 'SUITE_IN_USE',
    status: 409,
    title: 'Conflict',
    detail: `Suite ${suiteRef} still contains ${counts.cases} case${counts.cases === 1 ? '' : 's'}. They will all be deleted.`,
    instance,
    invalid_params: [{ name: 'suite_id', reason: `Contains ${parts.join(', ')}` }],
  });
}

export function sendPlanInUseError(
  reply: FastifyReply,
  planId: string,
  counts: { builds: number; caseLinks: number; executions: number },
  instance?: string,
  planName?: string
) {
  const planRef = planName ? planName : `(ID: ${planId})`;
  const parts: string[] = [];
  if (counts.builds > 0) parts.push(`${counts.builds} build${counts.builds === 1 ? '' : 's'}`);
  if (counts.caseLinks > 0) parts.push(`${counts.caseLinks} plan-linked case${counts.caseLinks === 1 ? '' : 's'}`);
  if (counts.executions > 0) parts.push(`${counts.executions} recorded execution${counts.executions === 1 ? '' : 's'}`);

  return sendProblemDetails(reply, {
    code: 'PLAN_IN_USE',
    status: 409,
    title: 'Conflict',
    detail: `Test Plan ${planRef} still contains ${counts.caseLinks} test case${counts.caseLinks === 1 ? '' : 's'}. Are you sure you want to delete the test plan with its test runs and links to test cases?`,
    instance,
    invalid_params: [{ name: 'plan_id', reason: `Contains ${parts.join(', ')}` }],
  });
}

export function sendBuildInUseError(
  reply: FastifyReply,
  buildId: string,
  counts: { executions: number },
  instance?: string,
  buildName?: string
) {
  const buildRef = buildName ? buildName : `(ID: ${buildId})`;

  return sendProblemDetails(reply, {
    code: 'BUILD_IN_USE',
    status: 409,
    title: 'Conflict',
    detail: `Test Run ${buildRef} still contains ${counts.executions} recorded execution${counts.executions === 1 ? '' : 's'}. Are you sure you want to delete the test run with its recorded executions?`,
    instance,
    invalid_params: [{ name: 'build_id', reason: `Has ${counts.executions} recorded execution${counts.executions === 1 ? '' : 's'}` }],
  });
}

export function sendCaseInUseError(
  reply: FastifyReply,
  caseId: string,
  counts: { planLinks: number; executions: number },
  instance?: string
) {
  const parts: string[] = [];
  if (counts.planLinks > 0) parts.push(`${counts.planLinks} plan link${counts.planLinks === 1 ? '' : 's'}`);
  if (counts.executions > 0) parts.push(`${counts.executions} recorded execution${counts.executions === 1 ? '' : 's'}`);

  return sendProblemDetails(reply, {
    code: 'CASE_IN_USE',
    status: 409,
    title: 'Conflict',
    detail: `Test Case (ID: ${caseId}) has ${parts.join(', ')}. Pass force=true to delete it anyway and permanently discard that history.`,
    instance,
    invalid_params: [{ name: 'case_id', reason: `Has ${parts.join(', ')}` }],
  });
}

export function sendCustomFieldInUseError(
  reply: FastifyReply,
  fieldId: string,
  blockedByValueCount: number,
  instance?: string,
  fieldLabel?: string
) {
  const fieldRef = fieldLabel ? `'${fieldLabel}'` : `(ID: ${fieldId})`;
  const entityWord = blockedByValueCount === 1 ? 'case/suite' : 'cases/suites';
  return sendProblemDetails(reply, {
    code: 'CUSTOM_FIELD_IN_USE',
    status: 409,
    title: 'Conflict',
    detail: `Custom field ${fieldRef} has recorded values on ${blockedByValueCount} ${entityWord}. Are you sure you want to delete them?`,
    instance,
    invalid_params: [
      {
        name: 'field_id',
        reason: `Has values on ${blockedByValueCount} entities`,
      },
    ],
  });
}

export function sendRoleInUseError(
  reply: FastifyReply,
  roleId: string,
  blockedByUserCount: number,
  instance?: string,
  roleName?: string
) {
  const roleLabel = roleName ? `'${roleName}'` : `(ID: ${roleId})`;
  return sendProblemDetails(reply, {
    code: 'ROLE_IN_USE',
    status: 409,
    title: 'Conflict',
    detail: `Role ${roleLabel} is currently assigned to ${blockedByUserCount} user${blockedByUserCount === 1 ? '' : 's'} and cannot be deleted. Reassign ${blockedByUserCount === 1 ? 'them' : 'them all'} first.`,
    instance,
    invalid_params: [
      {
        name: 'role_id',
        reason: `Assigned to ${blockedByUserCount} user${blockedByUserCount === 1 ? '' : 's'}`,
      },
    ],
  });
}

export function sendInvalidTokenError(reply: FastifyReply, instance?: string) {
  return sendProblemDetails(reply, {
    code: 'INVALID_TOKEN',
    status: 401,
    title: 'Unauthorized',
    detail: 'The provided API token is invalid.',
    instance,
  });
}

export function sendTokenRevokedError(reply: FastifyReply, instance?: string) {
  return sendProblemDetails(reply, {
    code: 'TOKEN_REVOKED',
    status: 401,
    title: 'Unauthorized',
    detail: 'This API token has been revoked.',
    instance,
  });
}

export function sendTokenExpiredError(reply: FastifyReply, instance?: string) {
  return sendProblemDetails(reply, {
    code: 'TOKEN_EXPIRED',
    status: 401,
    title: 'Unauthorized',
    detail: 'This API token has expired.',
    instance,
  });
}

export function sendTokenProjectMismatchError(
  reply: FastifyReply,
  tokenProjectId: string,
  requestedProjectId: string,
  instance?: string
) {
  return sendProblemDetails(reply, {
    code: 'TOKEN_PROJECT_MISMATCH',
    status: 403,
    title: 'Forbidden',
    detail: `This API token is scoped to project '${tokenProjectId}' and cannot be used against project '${requestedProjectId}'.`,
    instance,
    invalid_params: [
      {
        name: 'target_project_id',
        reason: "Does not match the authenticating token's bound project",
      },
    ],
  });
}

export function sendCapabilityCeilingExceededError(
  reply: FastifyReply,
  requestedKeys: string[],
  allowedKeys: string[],
  instance?: string
) {
  const excessKeys = requestedKeys.filter((k) => !allowedKeys.includes(k));
  return sendProblemDetails(reply, {
    code: 'CAPABILITY_CEILING_EXCEEDED',
    status: 403,
    title: 'Forbidden',
    detail: `Cannot grant capabilities you don't hold yourself on this project: ${excessKeys.join(', ')}.`,
    instance,
    invalid_params: excessKeys.map((key) => ({ name: 'capabilities', reason: `You do not hold '${key}' on this project` })),
  });
}

export function sendProjectInUseError(
  reply: FastifyReply,
  projectId: string,
  counts: { suites: number; cases: number; plans: number; runs: number; executions: number },
  instance?: string,
  projectName?: string
) {
  const ref = projectName ? projectName : `(ID: ${projectId})`;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const parts: string[] = [];
  if (counts.suites > 0) parts.push(plural(counts.suites, 'test suite'));
  if (counts.cases > 0) parts.push(plural(counts.cases, 'test case'));
  if (counts.plans > 0) parts.push(plural(counts.plans, 'test plan'));
  if (counts.runs > 0) parts.push(plural(counts.runs, 'test run'));
  if (counts.executions > 0) parts.push(plural(counts.executions, 'recorded result'));

  return sendProblemDetails(reply, {
    code: 'PROJECT_IN_USE',
    status: 409,
    title: 'Conflict',
    detail: `Project ${ref} still contains ${parts.join(', ')}. Are you sure you want to delete the project and everything in it?`,
    instance,
    invalid_params: [{ name: 'project_id', reason: `Contains ${parts.join(', ')}` }],
  });
}

// ---- Unexpected errors: never send their details to the client ----

/**
 * Whether an error's message is meant for users. The code throws plain `Error`s on purpose with
 * readable messages ("PASSWORD_POLICY_VIOLATION: ...", "Cannot move a suite into itself", a
 * parser's "line 3: ..."). Anything else -- a database driver error (table names, constraint
 * names, SQL), a TypeError, any other subclass -- is a bug or an outage, and its message stays in
 * the server log.
 */
export function isPublicError(err: unknown): err is Error {
  return err instanceof Error && Object.getPrototypeOf(err) === Error.prototype;
}

/** The error's message if it's meant for users, otherwise `fallback` (and the error is logged). */
export function publicErrorMessage(err: unknown, fallback: string, request?: { id?: string; method?: string; url?: string }): string {
  if (isPublicError(err)) return err.message;
  logServerError(err, request);
  return fallback;
}

export function logServerError(err: unknown, request?: { id?: string; method?: string; url?: string }): void {
  if (process.env.NODE_ENV === 'test') return;
  const where = request ? ` ${request.method ?? ''} ${request.url ?? ''} (request ${request.id ?? '?'})` : '';
  console.error(`[testify] Unexpected error${where}:`, err);
}

/** The generic reply for an unexpected error. The request id lets an admin find it in the log. */
export const INTERNAL_ERROR_MESSAGE = 'Something went wrong on the server. Please try again; if it keeps happening, ask an administrator to check the server log.';
