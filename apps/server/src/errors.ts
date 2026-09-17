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
