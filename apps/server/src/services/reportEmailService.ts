import type { Kysely } from 'kysely';
import type { Database, LastEmail, ReportSchedule, ReportScheduleSection } from '@testify/db';
import { BuildRepository, ProjectRepository, ReportScheduleRepository, RoleRepository, TestPlanRepository, UserRepository } from '@testify/db';
import { EMAILABLE_REPORTS, findReport, nextRunAt, renderReportEmail, validateReportParams, type EmailSection, type RenderedEmail } from '@testify/core';
import { ReportError, ReportService } from './reportService.js';
import { loadEmailSettings, sendEmail } from './mailer.js';

/** One report in a manually sent email: a catalog report id and its params. */
export interface EmailReportRequest {
  report_id: string;
  params: Record<string, unknown>;
}

export const SCHEDULE_SECTION_KINDS = ['overview', 'latest_run', 'test_health', 'plan_trend'] as const;

/** Reports-view tab for each report, for "Open in Testify" links (see ReportsView.tsx). */
const TAB_FOR_REPORT: Record<string, string> = {
  overview: 'overview',
  run_summary: 'run',
  plan_trend: 'trends',
  breakdown: 'trends',
  test_health: 'health',
};

/** A link to the report in the web app, built from the report's own output, or null when no
 * public URL is configured. Same hash format as the Reports view (#/reports/<tab>?...). */
function reportLink(publicUrl: string | null, projectId: string, reportId: string, data: any): string | null {
  if (!publicUrl) return null;
  const q = new URLSearchParams({ project: projectId });
  const planId = data?.run?.plan_id ?? data?.plan?.id;
  const runId = reportId === 'run_summary' ? data?.run?.id : data?.run?.id ?? null;
  if (planId) q.set('plan', planId);
  if (runId) q.set('run', runId);
  return `${publicUrl.replace(/\/+$/, '')}/#/reports/${TAB_FOR_REPORT[reportId] ?? 'overview'}?${q.toString()}`;
}

export type ScheduleSendResult =
  | { status: 'SENT' | 'CAPTURED' | 'FAILED'; error: string | null; email: LastEmail }
  | { status: 'SKIPPED' | 'FAILED'; error: string | null; email?: undefined };

/**
 * Builds report emails from the same ReportService the UI, REST and MCP use, and sends them
 * (manually, or for a schedule).
 */
export class ReportEmailService {
  private reports: ReportService;
  private projectRepo: ProjectRepository;
  private planRepo: TestPlanRepository;
  private buildRepo: BuildRepository;
  private scheduleRepo: ReportScheduleRepository;
  private roleRepo: RoleRepository;
  private userRepo: UserRepository;

  constructor(private db: Kysely<Database>) {
    this.reports = new ReportService(db);
    this.projectRepo = new ProjectRepository(db);
    this.planRepo = new TestPlanRepository(db);
    this.buildRepo = new BuildRepository(db);
    this.scheduleRepo = new ReportScheduleRepository(db);
    this.roleRepo = new RoleRepository(db);
    this.userRepo = new UserRepository(db);
  }

  /** Runs each requested report and renders one email. Throws ReportError for bad input. */
  async build(
    projectId: string,
    requests: EmailReportRequest[],
    opts: { title?: string; message?: string | null; sentBy?: string | null }
  ): Promise<RenderedEmail> {
    const project = await this.projectRepo.findById(projectId);
    if (!project) throw new ReportError(404, 'PROJECT_NOT_FOUND', 'Project not found');
    if (requests.length === 0) throw new ReportError(400, 'INVALID_PARAMS', 'Pick at least one report to email', { param: 'sections' });

    const { public_url } = await loadEmailSettings(this.db);
    const sections: EmailSection[] = [];
    for (const [i, req] of requests.entries()) {
      const report = findReport(req.report_id);
      if (!report || !EMAILABLE_REPORTS.includes(req.report_id)) {
        throw new ReportError(400, 'INVALID_PARAMS', `sections[${i}]: report '${req.report_id}' can't be emailed`, { param: `sections[${i}].report_id` });
      }
      const validation = validateReportParams(report, req.params ?? {});
      if (!validation.ok) {
        throw new ReportError(400, 'INVALID_PARAMS', `sections[${i}]: ${validation.errors.map((e) => `${e.param} ${e.reason}`).join('; ')}`, { param: `sections[${i}].params` });
      }
      const output = await this.reports.run(projectId, req.report_id, validation.params);
      sections.push({ reportId: req.report_id, data: output.data, url: reportLink(public_url, projectId, req.report_id, output.data) });
    }
    return renderReportEmail(sections, { projectName: project.name, title: opts.title, message: opts.message, sentBy: opts.sentBy });
  }

  /**
   * The report requests a schedule stands for, resolved now: "latest run" becomes the plan's
   * newest run. Also returns those run ids (for "only when there's a new run").
   */
  async resolveScheduleSections(schedule: ReportSchedule): Promise<{ requests: EmailReportRequest[]; runIds: string[] }> {
    const requests: EmailReportRequest[] = [];
    const runIds: string[] = [];
    for (const section of schedule.sections) {
      const filter = section.filter ? { filter: section.filter } : {};
      if (section.kind === 'overview') {
        requests.push({ report_id: 'overview', params: { days: 7 } });
      } else if (section.kind === 'latest_run') {
        const [latest] = await this.buildRepo.findByTestPlan(section.plan_id!);
        if (!latest) continue; // the plan has no runs yet -- nothing to summarize
        runIds.push(latest.id);
        requests.push({ report_id: 'run_summary', params: { run_id: latest.id, limit: 50, ...filter } });
      } else if (section.kind === 'test_health') {
        requests.push({ report_id: 'test_health', params: { plan_id: section.plan_id, runs: 10, stale_days: 30, limit: 10, ...filter } });
      } else if (section.kind === 'plan_trend') {
        requests.push({ report_id: 'plan_trend', params: { plan_id: section.plan_id, runs: 10, ...filter } });
      }
    }
    return { requests, runIds };
  }

  /** Why the schedule's creator can no longer send it, or null if they can. */
  private async creatorProblem(schedule: ReportSchedule): Promise<string | null> {
    const user = await this.userRepo.findById(schedule.created_by);
    if (!user || user.status === 'DISABLED') return 'The user who created this schedule no longer exists or is disabled.';
    const permissions = await this.roleRepo.evaluatePermissions(user.id, schedule.project_id);
    const admin = permissions.includes('SYSTEM_ADMIN');
    if (!admin && !(permissions.includes('REPORT_EMAIL') && permissions.includes('SPEC_VIEW'))) {
      return `${user.username} no longer has permission to email reports from this project.`;
    }
    return null;
  }

  /** Sends one schedule now and records the outcome on it. Never throws. */
  async sendSchedule(schedule: ReportSchedule, trigger: 'schedule' | 'manual'): Promise<ScheduleSendResult> {
    let result: ScheduleSendResult;
    try {
      const problem = await this.creatorProblem(schedule);
      if (problem) {
        result = { status: 'FAILED', error: problem };
      } else {
        const { requests, runIds } = await this.resolveScheduleSections(schedule);
        const unchanged =
          schedule.only_when_new_run &&
          runIds.length > 0 &&
          runIds.length === schedule.last_sent_run_ids.length &&
          runIds.every((id) => schedule.last_sent_run_ids.includes(id));
        if (requests.length === 0) {
          result = { status: 'SKIPPED', error: 'Nothing to send yet: the selected plans have no runs.' };
        } else if (unchanged) {
          result = { status: 'SKIPPED', error: 'No new run since the last email.' };
        } else {
          const creator = await this.userRepo.findById(schedule.created_by);
          const email = await this.build(schedule.project_id, requests, { title: schedule.name, message: schedule.message, sentBy: creator?.username ?? null });
          const sent = await sendEmail(this.db, {
            to: schedule.recipients,
            subject: email.subject,
            html: email.html,
            text: email.text,
            projectId: schedule.project_id,
            scheduleId: schedule.id,
            sentBy: schedule.created_by,
          });
          await this.db
            .insertInto('audit_logs')
            .values({
              id: crypto.randomUUID(),
              actor_id: schedule.created_by,
              actor_type: 'USER',
              action: 'REPORT_EMAILED',
              resource_type: 'report_schedule',
              resource_id: schedule.id,
              project_id: schedule.project_id,
              diff: JSON.stringify({ trigger, schedule_name: schedule.name, recipient_count: schedule.recipients.length, status: sent.status }),
              ip_address: null,
              user_agent: 'TestifyReportScheduler',
              created_at: new Date().toISOString(),
            })
            .execute();
          await this.scheduleRepo.recordResult(schedule.id, { status: sent.status, error: sent.error, sentRunIds: sent.status === 'FAILED' ? undefined : runIds });
          return { status: sent.status as 'SENT' | 'CAPTURED' | 'FAILED', error: sent.error, email: sent };
        }
      }
    } catch (err) {
      result = { status: 'FAILED', error: err instanceof Error ? err.message : String(err) };
    }
    await this.scheduleRepo.recordResult(schedule.id, { status: result.status, error: result.error });
    return result;
  }
}

/**
 * Sends every schedule that's due. Each is first claimed by moving next_run_at forward with a
 * compare-and-set, so if several server instances poll at once only one sends it.
 */
export async function runDueSchedules(db: Kysely<Database>, now: Date = new Date()): Promise<Array<{ id: string; status: string }>> {
  const repo = new ReportScheduleRepository(db);
  const service = new ReportEmailService(db);
  const results: Array<{ id: string; status: string }> = [];
  for (const schedule of await repo.findDue(now.toISOString())) {
    const next = nextRunAt(
      { frequency: schedule.frequency as 'DAILY' | 'WEEKLY', weekday: schedule.weekday, time_of_day: schedule.time_of_day, timezone: schedule.timezone },
      now
    ).toISOString();
    if (!(await repo.claim(schedule.id, schedule.next_run_at, next))) continue;
    const result = await service.sendSchedule(schedule, 'schedule');
    results.push({ id: schedule.id, status: result.status });
  }
  return results;
}

/** Checks a section list from a request; returns the cleaned sections or an error message. */
export async function parseScheduleSections(
  db: Kysely<Database>,
  projectId: string,
  raw: unknown
): Promise<{ ok: true; sections: ReportScheduleSection[] } | { ok: false; error: string }> {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'sections must be a non-empty list' };
  if (raw.length > 10) return { ok: false, error: 'sections: at most 10' };
  const planRepo = new TestPlanRepository(db);
  const sections: ReportScheduleSection[] = [];
  for (const [i, s] of raw.entries()) {
    const kind = (s as any)?.kind;
    if (!SCHEDULE_SECTION_KINDS.includes(kind)) return { ok: false, error: `sections[${i}].kind must be one of ${SCHEDULE_SECTION_KINDS.join(', ')}` };
    const section: ReportScheduleSection = { kind };
    if (kind !== 'overview') {
      const planId = (s as any).plan_id;
      const plan = typeof planId === 'string' ? await planRepo.findById(planId) : undefined;
      if (!plan || plan.project_id !== projectId) return { ok: false, error: `sections[${i}].plan_id must be a test plan of this project` };
      section.plan_id = planId;
      const filter = (s as any).filter;
      if (filter !== undefined && filter !== null) {
        if (typeof filter !== 'object' || Array.isArray(filter)) return { ok: false, error: `sections[${i}].filter must be an object` };
        section.filter = filter;
      }
    }
    sections.push(section);
  }
  return { ok: true, sections };
}
