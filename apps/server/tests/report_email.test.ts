import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import nodemailer from 'nodemailer';
import { createServer } from '../src/server.js';
import { setTransportFactoryForTests } from '../src/services/mailer.js';
import { runDueSchedules } from '../src/services/reportEmailService.js';
import { ProjectRepository, ReportScheduleRepository, TestPlanRepository } from '@testify/db';

describe('Report emails: settings, outbox, manual sends and schedules', () => {
  let serverInstance: any;

  beforeEach(async () => {
    serverInstance = await createServer();
  });

  afterEach(async () => {
    setTransportFactoryForTests(null);
    await serverInstance.db.destroy();
  });

  async function loginAsAdmin(app: any): Promise<string> {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } });
    return JSON.parse(res.payload).token;
  }

  async function createAndLoginAs(app: any, adminToken: string, globalRole: string): Promise<{ token: string; userId: string }> {
    const username = `${globalRole.replace(/\s+/g, '_').toLowerCase()}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { username, email: `${username}@testify.local`, password: 'SecurePass123!', global_role: globalRole },
    });
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password: 'SecurePass123!' } });
    return { token: JSON.parse(login.payload).token, userId: JSON.parse(createRes.payload).user.id };
  }

  const call = (app: any, token: string, method: string, url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined ? { payload } : {}) });

  async function outbox(app: any, token: string) {
    return JSON.parse((await call(app, token, 'GET', '/api/v1/admin/email-outbox')).payload);
  }

  function scheduleBody(planId: string, extra: Record<string, unknown> = {}) {
    return {
      name: 'Weekly digest',
      sections: [{ kind: 'overview' }, { kind: 'latest_run', plan_id: planId }],
      recipients: 'boss@example.com, qa@example.com',
      frequency: 'WEEKLY',
      weekday: 1,
      time_of_day: '09:00',
      timezone: 'Europe/London',
      ...extra,
    };
  }

  describe('email settings and the outbox', () => {
    it('never returns the password; only admins can read or change settings', async () => {
      const { app } = serverInstance;
      const admin = await loginAsAdmin(app);
      const initial = JSON.parse((await call(app, admin, 'GET', '/api/v1/admin/email-settings')).payload).settings;
      expect(initial).toMatchObject({ smtp_host: null, has_password: false, delivery: 'capture_only' });

      const put = await call(app, admin, 'PUT', '/api/v1/admin/email-settings', {
        smtp_host: 'smtp.example.com', smtp_port: 587, smtp_user: 'me', smtp_password: 's3cret', from: 'Testify <qa@example.com>', public_url: 'https://testify.example.com/',
      });
      expect(put.statusCode).toBe(200);
      expect(put.payload).not.toContain('s3cret');
      expect(JSON.parse(put.payload).settings).toMatchObject({ smtp_host: 'smtp.example.com', smtp_port: 587, has_password: true, public_url: 'https://testify.example.com', delivery: 'smtp' });

      // Leaving the password out keeps it.
      await call(app, admin, 'PUT', '/api/v1/admin/email-settings', { smtp_host: 'smtp.example.com', from: 'qa@example.com' });
      expect(JSON.parse((await call(app, admin, 'GET', '/api/v1/admin/email-settings')).payload).settings.has_password).toBe(true);

      expect((await call(app, admin, 'PUT', '/api/v1/admin/email-settings', { smtp_port: 99999 })).statusCode).toBe(400);
      expect((await call(app, admin, 'PUT', '/api/v1/admin/email-settings', { public_url: 'ftp://x' })).statusCode).toBe(400);

      const { token: lead } = await createAndLoginAs(app, admin, 'Test Lead');
      expect((await call(app, lead, 'GET', '/api/v1/admin/email-settings')).statusCode).toBe(403);
      expect((await call(app, lead, 'GET', '/api/v1/admin/email-outbox')).statusCode).toBe(403);
    });

    it('test email: captured with no SMTP host, sent through the transport with one, failed when it errors', async () => {
      const { app } = serverInstance;
      const admin = await loginAsAdmin(app);

      const captured = JSON.parse((await call(app, admin, 'POST', '/api/v1/admin/email-settings/test', { to: 'me@example.com' })).payload);
      expect(captured.outbox.status).toBe('CAPTURED');

      await call(app, admin, 'PUT', '/api/v1/admin/email-settings', { smtp_host: 'smtp.example.com' });
      const sentMessages: any[] = [];
      setTransportFactoryForTests(() => {
        const t = nodemailer.createTransport({ jsonTransport: true });
        return { sendMail: async (m: any) => { sentMessages.push(m); return t.sendMail(m); } } as any;
      });
      const sent = JSON.parse((await call(app, admin, 'POST', '/api/v1/admin/email-settings/test', { to: 'me@example.com' })).payload);
      expect(sent.outbox.status).toBe('SENT');
      expect(sentMessages[0]).toMatchObject({ to: ['me@example.com'], subject: 'Testify test email' });

      setTransportFactoryForTests(() => ({ sendMail: async () => { throw new Error('connection refused'); } }) as any);
      const failed = JSON.parse((await call(app, admin, 'POST', '/api/v1/admin/email-settings/test', { to: 'me@example.com' })).payload);
      expect(failed.outbox).toMatchObject({ status: 'FAILED', error: 'connection refused' });

      const list = await outbox(app, admin);
      expect(list.total).toBe(3);
      expect(list.entries.map((e: any) => e.status)).toEqual(['FAILED', 'SENT', 'CAPTURED']);
      const one = JSON.parse((await call(app, admin, 'GET', `/api/v1/admin/email-outbox/${list.entries[0].id}`)).payload);
      expect(one.entry.html).toContain('Testify can send email');
    });
  });

  describe('Email this report', () => {
    it('preview renders without sending; sending writes the outbox and an audit row', async () => {
      const { app, seed } = serverInstance;
      const admin = await loginAsAdmin(app);
      await call(app, admin, 'PUT', '/api/v1/admin/email-settings', { public_url: 'https://testify.example.com' });
      const url = `/api/v1/projects/${seed.projectId}/report-emails`;
      const sections = [{ report_id: 'run_summary', params: { run_id: seed.buildId } }];

      const preview = await call(app, admin, 'POST', url, { sections, preview: true });
      expect(preview.statusCode).toBe(200);
      const p = JSON.parse(preview.payload);
      expect(p.subject).toMatch(/^Testify · .* · Run /);
      expect(p.html).toContain(`https://testify.example.com/#/reports/run?project=${seed.projectId}`);
      expect((await outbox(app, admin)).total).toBe(0);

      const sent = await call(app, admin, 'POST', url, { sections, recipients: ['Boss@Example.com', 'boss@example.com', 'qa@example.com'], message: 'Release status' });
      expect(sent.statusCode).toBe(201);
      expect(JSON.parse(sent.payload).outbox).toMatchObject({ status: 'CAPTURED', recipients: ['boss@example.com', 'qa@example.com'] });
      expect((await outbox(app, admin)).total).toBe(1);

      const audit = JSON.parse((await call(app, admin, 'GET', '/api/v1/admin/audit-logs')).payload).audit_logs;
      expect(audit.some((a: any) => a.action === 'REPORT_EMAILED')).toBe(true);
    });

    it('validates recipients and sections; needs REPORT_EMAIL; a token from another project is refused', async () => {
      const { app, db, seed } = serverInstance;
      const admin = await loginAsAdmin(app);
      const url = `/api/v1/projects/${seed.projectId}/report-emails`;
      const sections = [{ report_id: 'overview', params: {} }];

      const badAddress = await call(app, admin, 'POST', url, { sections, recipients: 'not-an-email' });
      expect(badAddress.statusCode).toBe(400);
      expect(JSON.parse(badAddress.payload).details[0].param).toBe('recipients');
      const tooMany = Array.from({ length: 51 }, (_, i) => `u${i}@x.com`);
      expect((await call(app, admin, 'POST', url, { sections, recipients: tooMany })).statusCode).toBe(400);
      expect((await call(app, admin, 'POST', url, { sections: [{ report_id: 'case_history', params: { case_id: 'SHOP-101' } }], recipients: 'a@b.co' })).statusCode).toBe(400);
      expect((await call(app, admin, 'POST', url, { sections: [{ report_id: 'run_summary', params: {} }], recipients: 'a@b.co' })).statusCode).toBe(400);

      const { token: tester } = await createAndLoginAs(app, admin, 'Tester');
      expect((await call(app, tester, 'POST', url, { sections, recipients: 'a@b.co' })).statusCode).toBe(403);

      const other = await new ProjectRepository(db).create({ name: 'Other', prefix: 'OTH' });
      const mint = await call(app, admin, 'POST', `/api/v1/projects/${other.id}/api-tokens`, { name: 'x', capabilities: ['SPEC_VIEW', 'REPORT_EMAIL'] });
      const otherToken = JSON.parse(mint.payload).plaintext;
      expect((await call(app, otherToken, 'POST', url, { sections, recipients: 'a@b.co' })).statusCode).toBe(403);
    });
  });

  describe('scheduled emails', () => {
    it('create / list / update / delete with validation; Viewers are refused', async () => {
      const { app, db, seed } = serverInstance;
      const admin = await loginAsAdmin(app);
      const base = `/api/v1/projects/${seed.projectId}/report-schedules`;

      const created = await call(app, admin, 'POST', base, scheduleBody(seed.planId));
      expect(created.statusCode).toBe(201);
      const schedule = JSON.parse(created.payload).schedule;
      expect(schedule).toMatchObject({ name: 'Weekly digest', recipients: ['boss@example.com', 'qa@example.com'], enabled: true, frequency: 'WEEKLY' });
      expect(new Date(schedule.next_run_at).getUTCDay()).toBe(1);

      const bad = async (extra: Record<string, unknown>, param: string) => {
        const res = await call(app, admin, 'POST', base, scheduleBody(seed.planId, extra));
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.payload).details[0].param).toBe(param);
      };
      await bad({ timezone: 'Mars/Base' }, 'timezone');
      await bad({ time_of_day: '9am' }, 'time_of_day');
      await bad({ recipients: '' }, 'recipients');
      await bad({ sections: [{ kind: 'nope' }] }, 'sections');
      const otherPlan = await new TestPlanRepository(db).create({ project_id: (await new ProjectRepository(db).create({ name: 'O', prefix: 'OO' })).id, name: 'x' });
      await bad({ sections: [{ kind: 'latest_run', plan_id: otherPlan.id }] }, 'sections');

      const list = JSON.parse((await call(app, admin, 'GET', base)).payload).schedules;
      expect(list).toHaveLength(1);

      const updated = await call(app, admin, 'PUT', `${base}/${schedule.id}`, scheduleBody(seed.planId, { frequency: 'DAILY', enabled: false }));
      expect(JSON.parse(updated.payload).schedule).toMatchObject({ frequency: 'DAILY', weekday: null, enabled: false });

      const { token: viewer } = await createAndLoginAs(app, admin, 'Viewer');
      expect((await call(app, viewer, 'GET', base)).statusCode).toBe(403);

      expect(JSON.parse((await call(app, admin, 'DELETE', `${base}/${schedule.id}`)).payload).deleted).toBe(true);
      expect(JSON.parse((await call(app, admin, 'GET', base)).payload).schedules).toHaveLength(0);
    });

    it('runDueSchedules sends due schedules once and advances them; claims are exclusive', async () => {
      const { app, db, seed } = serverInstance;
      const admin = await loginAsAdmin(app);
      const created = JSON.parse((await call(app, admin, 'POST', `/api/v1/projects/${seed.projectId}/report-schedules`, scheduleBody(seed.planId))).payload).schedule;
      const repo = new ReportScheduleRepository(db);

      expect(await runDueSchedules(db, new Date())).toEqual([]); // not due yet

      const due = '2020-01-01T00:00:00.000Z';
      await db.updateTable('report_schedules').set({ next_run_at: due }).where('id', '=', created.id).execute();
      const results = await runDueSchedules(db, new Date());
      expect(results).toEqual([{ id: created.id, status: 'CAPTURED' }]);
      const after = await repo.findById(created.id);
      expect(new Date(after!.next_run_at).getTime()).toBeGreaterThan(Date.now());
      expect(after).toMatchObject({ last_status: 'CAPTURED', last_sent_run_ids: [seed.buildId] });
      expect(await runDueSchedules(db, new Date())).toEqual([]);

      const entries = (await outbox(app, admin)).entries;
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ subject: expect.stringContaining('Weekly digest'), schedule_id: created.id });

      // A second instance holding the stale next_run_at loses the claim.
      expect(await repo.claim(created.id, due, '2099-01-01T00:00:00.000Z')).toBe(false);
    });

    it('"only when there\'s a new run" skips a repeat; a creator who lost access fails', async () => {
      const { app, seed } = serverInstance;
      const admin = await loginAsAdmin(app);
      const base = `/api/v1/projects/${seed.projectId}/report-schedules`;

      const onlyNew = JSON.parse((await call(app, admin, 'POST', base, scheduleBody(seed.planId, { only_when_new_run: true }))).payload).schedule;
      const first = JSON.parse((await call(app, admin, 'POST', `${base}/${onlyNew.id}/send-now`)).payload);
      expect(first.status).toBe('CAPTURED');
      const second = JSON.parse((await call(app, admin, 'POST', `${base}/${onlyNew.id}/send-now`)).payload);
      expect(second).toMatchObject({ status: 'SKIPPED', error: 'No new run since the last email.' });
      expect(second.schedule.last_status).toBe('SKIPPED');

      const { token: lead, userId } = await createAndLoginAs(app, admin, 'Test Lead');
      const leads = JSON.parse((await call(app, lead, 'POST', base, scheduleBody(seed.planId))).payload).schedule;
      await call(app, admin, 'PUT', `/api/v1/admin/users/${userId}/status`, { status: 'DISABLED' });
      const failed = JSON.parse((await call(app, admin, 'POST', `${base}/${leads.id}/send-now`)).payload);
      expect(failed.status).toBe('FAILED');
      expect(failed.error).toContain('disabled');
    });
  });
});
