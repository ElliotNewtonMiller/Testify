import type { FastifyInstance, FastifyReply } from 'fastify';
import { withinRateLimit } from '../services/rateLimits.js';
import type { Kysely } from 'kysely';
import { v4 as uuidv4 } from 'uuid';
import type { Database, ReportScheduleInput } from '@testify/db';
import { ProjectRepository, ReportScheduleRepository } from '@testify/db';
import { MAX_RECIPIENTS, isValidEmail, nextRunAt, parseRecipients, validateScheduleTiming } from '@testify/core';
import { requirePermission, type AuthenticatedUser } from '../middleware/auth.js';
import { ReportError } from '../services/reportService.js';
import { ReportEmailService, parseScheduleSections, type EmailReportRequest } from '../services/reportEmailService.js';
import { sendEmail } from '../services/mailer.js';
import { requestOrigin, type RequestOrigin } from '../audit.js';

import { sendError, reportErrorParams } from '../errors.js';
import * as O from '../openapi/areas/other.js';
/**
 * Emailing reports, all gated on REPORT_EMAIL (sending project data outside Testify) and
 * nested under :projectId so project role overrides and API-token scoping apply:
 *
 * POST /api/v1/projects/:projectId/report-emails  { sections: [{report_id, params}], recipients, message?, preview? }
 *      preview: true returns { subject, html } and sends nothing.
 * GET/POST/PUT/DELETE /api/v1/projects/:projectId/report-schedules[/:id]
 * POST /api/v1/projects/:projectId/report-schedules/:id/send-now
 */
export async function registerReportEmailRoutes(app: FastifyInstance, db: Kysely<Database>, jwtSecret: string) {
  const projectRepo = new ProjectRepository(db);
  const scheduleRepo = new ReportScheduleRepository(db);
  const emails = new ReportEmailService(db);
  const gate = { preHandler: requirePermission('REPORT_EMAIL', db, jwtSecret) };

  const badRequest = (reply: FastifyReply, field: string, reason: string) =>
    sendError(reply, 400, `${field} ${reason}`, { code: 'INVALID_PARAMS', invalid_params: [{ name: field, reason }] });

  function recipientsOrError(raw: unknown): { recipients: string[] } | { field: string; reason: string } {
    if (!(typeof raw === 'string' || (Array.isArray(raw) && raw.every((r) => typeof r === 'string')))) {
      return { field: 'recipients', reason: 'must be a list of email addresses' };
    }
    const parsed = parseRecipients(raw as string | string[]);
    if (parsed.invalid.length) return { field: 'recipients', reason: `has invalid addresses: ${parsed.invalid.slice(0, 5).join(', ')}` };
    if (parsed.recipients.length === 0) return { field: 'recipients', reason: 'needs at least one email address' };
    if (parsed.tooMany) return { field: 'recipients', reason: `can have at most ${MAX_RECIPIENTS} addresses` };
    return { recipients: parsed.recipients };
  }

  async function audit(origin: RequestOrigin, actor: AuthenticatedUser, action: string, resourceType: string, resourceId: string, projectId: string, diff: Record<string, unknown>) {
    await db
      .insertInto('audit_logs')
      .values({
        id: uuidv4(),
        actor_id: actor.id,
        actor_type: actor.api_token ? 'SERVICE_ACCOUNT' : 'USER',
        action,
        resource_type: resourceType,
        resource_id: resourceId,
        project_id: projectId,
        diff: JSON.stringify(diff),
        ...origin,
        created_at: new Date().toISOString(),
      })
      .execute();
  }

  const sendReportError = (reply: FastifyReply, err: unknown) => {
    if (err instanceof ReportError) {
      return sendError(reply, err.status, err.message, { code: err.code, ...reportErrorParams(err.details) });
    }
    throw err;
  };

  // ---- Manual "Email this report" -----------------------------------------------------

  app.post('/api/v1/projects/:projectId/report-emails', { schema: O.sendReportEmailSchema, ...gate }, async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const body = (request.body ?? {}) as { sections?: unknown; recipients?: unknown; message?: unknown; preview?: unknown };
    const actor = request.user!;

    if (!Array.isArray(body.sections) || body.sections.length === 0 || body.sections.length > 10) {
      return badRequest(reply, 'sections', 'must be a list of 1-10 { report_id, params }');
    }
    const sections: EmailReportRequest[] = body.sections.map((s: any) => ({ report_id: String(s?.report_id ?? ''), params: s?.params && typeof s.params === 'object' ? s.params : {} }));
    if (body.message !== undefined && body.message !== null && (typeof body.message !== 'string' || body.message.length > 2000)) {
      return badRequest(reply, 'message', 'must be text of at most 2000 characters');
    }
    const message = (body.message as string | undefined) ?? null;

    let recipients: string[] = [];
    if (!body.preview) {
      const r = recipientsOrError(body.recipients);
      if ('field' in r) return badRequest(reply, r.field, r.reason);
      recipients = r.recipients;
      // Previews don't count; sending does.
      if (!withinRateLimit(request, reply, app.rateLimits.reportEmails, 'report emails')) return reply;
    }

    let email;
    try {
      email = await emails.run(projectId, sections, { message, sentBy: actor.username });
    } catch (err) {
      return sendReportError(reply, err);
    }
    if (body.preview) return { subject: email.subject, html: email.html };

    const sent = await sendEmail(db, { to: recipients, subject: email.subject, html: email.html, text: email.text, projectId, sentBy: actor.id });
    await audit(requestOrigin(request), actor, 'REPORT_EMAILED', 'project', projectId, projectId, {
      trigger: 'manual',
      reports: sections.map((s) => s.report_id),
      recipient_count: recipients.length,
      status: sent.status,
    });
    return reply.status(201).send({ email: { status: sent.status, error: sent.error, subject: sent.subject, recipients: sent.recipients } });
  });

  // ---- Schedules ------------------------------------------------------------------------

  async function parseScheduleBody(projectId: string, body: any): Promise<{ input: ReportScheduleInput } | { field: string; reason: string }> {
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 255) return { field: 'name', reason: 'is required (at most 255 characters)' };
    const sections = await parseScheduleSections(db, projectId, body?.sections);
    if (!sections.ok) return { field: 'sections', reason: sections.error.replace(/^sections:?\s*/, '') };
    const r = recipientsOrError(body?.recipients);
    if ('field' in r) return r;
    if (body?.message !== undefined && body?.message !== null && (typeof body.message !== 'string' || body.message.length > 2000)) {
      return { field: 'message', reason: 'must be text of at most 2000 characters' };
    }
    const timing = {
      frequency: body?.frequency,
      weekday: body?.frequency === 'WEEKLY' ? body?.weekday : null,
      time_of_day: body?.time_of_day,
      timezone: body?.timezone,
    };
    const timingErrors = validateScheduleTiming(timing);
    if (timingErrors.length) return timingErrors[0];
    return {
      input: {
        name,
        sections: sections.sections,
        recipients: r.recipients,
        message: body?.message ? String(body.message) : null,
        frequency: timing.frequency,
        weekday: timing.weekday ?? null,
        time_of_day: timing.time_of_day,
        timezone: timing.timezone,
        only_when_new_run: Boolean(body?.only_when_new_run),
        enabled: body?.enabled === undefined ? true : Boolean(body.enabled),
      },
    };
  }

  const nextFor = (input: ReportScheduleInput) =>
    nextRunAt({ frequency: input.frequency, weekday: input.weekday, time_of_day: input.time_of_day, timezone: input.timezone }, new Date()).toISOString();

  async function scheduleInProject(projectId: string, id: string) {
    const schedule = await scheduleRepo.findById(id);
    return schedule && schedule.project_id === projectId ? schedule : null;
  }

  app.get('/api/v1/projects/:projectId/report-schedules', { schema: O.listSchedulesSchema, ...gate }, async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    if (!(await projectRepo.findById(projectId))) return sendError(reply, 404, 'Project not found');
    return { schedules: await scheduleRepo.listByProject(projectId) };
  });

  app.post('/api/v1/projects/:projectId/report-schedules', { schema: O.createScheduleSchema, ...gate }, async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    if (!(await projectRepo.findById(projectId))) return sendError(reply, 404, 'Project not found');
    const parsed = await parseScheduleBody(projectId, request.body);
    if ('field' in parsed) return badRequest(reply, parsed.field, parsed.reason);
    const schedule = await scheduleRepo.create(projectId, request.user!.id, parsed.input, nextFor(parsed.input));
    await audit(requestOrigin(request), request.user!, 'REPORT_SCHEDULE_CREATED', 'report_schedule', schedule.id, projectId, {
      name: schedule.name,
      recipient_count: schedule.recipients.length,
      frequency: schedule.frequency,
    });
    return reply.status(201).send({ schedule });
  });

  app.put('/api/v1/report-schedules/:scheduleId', { schema: O.replaceScheduleSchema, ...gate }, async (request, reply) => {
    const { scheduleId: id } = request.params as { scheduleId: string };
    const projectId = request.projectId ?? '';
    if (!(await scheduleInProject(projectId, id))) return sendError(reply, 404, 'Schedule not found in this project');
    const parsed = await parseScheduleBody(projectId, request.body);
    if ('field' in parsed) return badRequest(reply, parsed.field, parsed.reason);
    const schedule = await scheduleRepo.update(id, parsed.input, nextFor(parsed.input));
    await audit(requestOrigin(request), request.user!, 'REPORT_SCHEDULE_UPDATED', 'report_schedule', id, projectId, {
      name: parsed.input.name,
      recipient_count: parsed.input.recipients.length,
      enabled: parsed.input.enabled,
    });
    return { schedule };
  });

  // One recipient at a time, without resending the whole schedule.

  app.post('/api/v1/report-schedules/:scheduleId/recipients', { schema: O.addRecipientSchema, ...gate }, async (request, reply) => {
    const { scheduleId: id } = request.params as { scheduleId: string };
    const projectId = request.projectId ?? '';
    if (!(await scheduleInProject(projectId, id))) return sendError(reply, 404, 'Schedule not found in this project');
    const email = String((request.body as { email?: unknown })?.email ?? '').trim().toLowerCase();
    if (!isValidEmail(email)) return badRequest(reply, 'email', 'must be one email address');
    const result = await scheduleRepo.changeRecipients(id, (current) => {
      if (current.includes(email)) return current;
      if (current.length >= MAX_RECIPIENTS) return { refused: `can have at most ${MAX_RECIPIENTS} addresses` };
      return [...current, email];
    });
    if (!result) return sendError(reply, 404, 'Schedule not found in this project');
    if ('refused' in result) return badRequest(reply, 'recipients', result.refused);
    if (result.changed) {
      await audit(requestOrigin(request), request.user!, 'REPORT_SCHEDULE_UPDATED', 'report_schedule', id, projectId, {
        name: result.schedule.name,
        recipient_count: result.schedule.recipients.length,
        change: 'recipient_added',
      });
    }
    return { schedule: result.schedule };
  });

  app.delete('/api/v1/report-schedules/:scheduleId/recipients/:email', { schema: O.removeRecipientSchema, ...gate }, async (request, reply) => {
    const { scheduleId: id, email: rawEmail } = request.params as { scheduleId: string; email: string };
    const projectId = request.projectId ?? '';
    if (!(await scheduleInProject(projectId, id))) return sendError(reply, 404, 'Schedule not found in this project');
    const email = rawEmail.trim().toLowerCase();
    const result = await scheduleRepo.changeRecipients(id, (current) => {
      if (!current.includes(email)) return { refused: 'NOT_A_RECIPIENT' };
      if (current.length === 1) return { refused: 'LAST_RECIPIENT' };
      return current.filter((r) => r !== email);
    });
    if (!result) return sendError(reply, 404, 'Schedule not found in this project');
    if ('refused' in result) {
      return result.refused === 'NOT_A_RECIPIENT'
        ? sendError(reply, 404, `${email} isn't a recipient of this schedule`)
        : sendError(reply, 409, "This is the schedule's only recipient. Add another first, or delete the schedule.", { code: 'LAST_RECIPIENT' });
    }
    await audit(requestOrigin(request), request.user!, 'REPORT_SCHEDULE_UPDATED', 'report_schedule', id, projectId, {
      name: result.schedule.name,
      recipient_count: result.schedule.recipients.length,
      change: 'recipient_removed',
    });
    return reply.status(204).send();
  });

  app.delete('/api/v1/report-schedules/:scheduleId', { schema: O.deleteScheduleSchema, ...gate }, async (request, reply) => {
    const { scheduleId: id } = request.params as { scheduleId: string };
    const projectId = request.projectId ?? '';
    const existing = await scheduleInProject(projectId, id);
    if (!existing) return sendError(reply, 404, 'Schedule not found in this project');
    await scheduleRepo.delete(id);
    await audit(requestOrigin(request), request.user!, 'REPORT_SCHEDULE_DELETED', 'report_schedule', id, projectId, { name: existing.name });
    return reply.status(204).send();
  });

  app.post('/api/v1/report-schedules/:scheduleId/send-now', { schema: O.sendScheduleNowSchema, ...gate }, async (request, reply) => {
    const { scheduleId: id } = request.params as { scheduleId: string };
    const projectId = request.projectId ?? '';
    const schedule = await scheduleInProject(projectId, id);
    if (!schedule) return sendError(reply, 404, 'Schedule not found in this project');
    if (!withinRateLimit(request, reply, app.rateLimits.reportEmails, 'report emails')) return reply;
    const result = await emails.sendSchedule(schedule, 'manual', requestOrigin(request));
    return {
      status: result.status,
      error: result.error,
      email: result.email ? { status: result.email.status, subject: result.email.subject } : null,
      schedule: await scheduleRepo.findById(id),
    };
  });
}
