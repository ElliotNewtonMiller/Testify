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

export function sendCaseHasExecutionsError(reply: FastifyReply, testCaseId: string, instance?: string) {
  return sendProblemDetails(reply, {
    code: 'CASE_HAS_EXECUTIONS',
    detail: `Test Case (ID: ${testCaseId}) has recorded executions in this Test Plan and cannot be unlinked. Executions retain their original version reference permanently.`,
    instance,
    invalid_params: [
      {
        name: 'test_case_id',
        reason: 'Existing executions reference this plan-case row',
      },
    ],
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
    detail: `Custom field ${fieldRef} has recorded values on ${blockedByValueCount} ${entityWord}. Pass force=true to delete it anyway and permanently discard that data.`,
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
