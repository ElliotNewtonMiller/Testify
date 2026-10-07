import type { Kysely, Selectable } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import type { Database, LastEmailTable, ReportSchedulesTable } from '../types.js';

/** Key/value settings stored in system_settings (e.g. the SMTP server for report emails). */
export class SystemSettingsRepository {
  constructor(private db: Kysely<Database>) {}

  async getMany(keys: string[]): Promise<Record<string, string>> {
    if (keys.length === 0) return {};
    const rows = await this.db.selectFrom('system_settings').select(['key', 'value']).where('key', 'in', keys).execute();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  /** Upserts each entry; a null value deletes the key. */
  async setMany(entries: Record<string, string | null>): Promise<void> {
    const now = new Date().toISOString();
    for (const [key, value] of Object.entries(entries)) {
      if (value === null) {
        await this.db.deleteFrom('system_settings').where('key', '=', key).execute();
      } else {
        await this.db
          .insertInto('system_settings')
          .values({ key, value, description: null, updated_at: now })
          .onConflict((oc) => oc.column('key').doUpdateSet({ value, updated_at: now }))
          .execute();
      }
    }
  }
}

export interface ReportScheduleSection {
  kind: 'overview' | 'latest_run' | 'test_health' | 'plan_trend';
  plan_id?: string;
  filter?: Record<string, unknown>;
}

/** A schedule with its JSON columns parsed. */
export interface ReportSchedule extends Omit<Selectable<ReportSchedulesTable>, 'sections' | 'recipients' | 'last_sent_run_ids'> {
  sections: ReportScheduleSection[];
  recipients: string[];
  last_sent_run_ids: string[];
}

export interface ReportScheduleInput {
  name: string;
  sections: ReportScheduleSection[];
  recipients: string[];
  message: string | null;
  frequency: 'DAILY' | 'WEEKLY';
  weekday: number | null;
  time_of_day: string;
  timezone: string;
  only_when_new_run: boolean;
  enabled: boolean;
}

function parseList<T>(json: string | null): T[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function toSchedule(row: Selectable<ReportSchedulesTable>): ReportSchedule {
  return {
    ...row,
    only_when_new_run: Boolean(row.only_when_new_run),
    enabled: Boolean(row.enabled),
    sections: parseList<ReportScheduleSection>(row.sections),
    recipients: parseList<string>(row.recipients),
    last_sent_run_ids: parseList<string>(row.last_sent_run_ids),
  };
}

export class ReportScheduleRepository {
  constructor(private db: Kysely<Database>) {}

  async listByProject(projectId: string): Promise<ReportSchedule[]> {
    const rows = await this.db.selectFrom('report_schedules').selectAll().where('project_id', '=', projectId).orderBy('created_at', 'asc').execute();
    return rows.map(toSchedule);
  }

  async findById(id: string): Promise<ReportSchedule | undefined> {
    const row = await this.db.selectFrom('report_schedules').selectAll().where('id', '=', id).executeTakeFirst();
    return row ? toSchedule(row) : undefined;
  }

  async create(projectId: string, createdBy: string, input: ReportScheduleInput, nextRunAt: string): Promise<ReportSchedule> {
    const now = new Date().toISOString();
    const id = uuidv7();
    await this.db
      .insertInto('report_schedules')
      .values({
        id,
        project_id: projectId,
        name: input.name,
        sections: JSON.stringify(input.sections),
        recipients: JSON.stringify(input.recipients),
        message: input.message,
        frequency: input.frequency,
        weekday: input.weekday,
        time_of_day: input.time_of_day,
        timezone: input.timezone,
        only_when_new_run: input.only_when_new_run,
        enabled: input.enabled,
        next_run_at: nextRunAt,
        created_by: createdBy,
        created_at: now,
        updated_at: now,
      })
      .execute();
    return (await this.findById(id))!;
  }

  async update(id: string, input: ReportScheduleInput, nextRunAt: string): Promise<ReportSchedule | undefined> {
    await this.db
      .updateTable('report_schedules')
      .set({
        name: input.name,
        sections: JSON.stringify(input.sections),
        recipients: JSON.stringify(input.recipients),
        message: input.message,
        frequency: input.frequency,
        weekday: input.weekday,
        time_of_day: input.time_of_day,
        timezone: input.timezone,
        only_when_new_run: input.only_when_new_run,
        enabled: input.enabled,
        next_run_at: nextRunAt,
        updated_at: new Date().toISOString(),
      })
      .where('id', '=', id)
      .execute();
    return this.findById(id);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.deleteFrom('report_schedules').where('id', '=', id).executeTakeFirst();
    return (result.numDeletedRows ?? 0n) > 0n;
  }

  /** Enabled schedules whose next send time has come. */
  async findDue(nowIso: string): Promise<ReportSchedule[]> {
    const rows = await this.db
      .selectFrom('report_schedules')
      .selectAll()
      .where('enabled', '=', true)
      .where('next_run_at', '<=', nowIso)
      .orderBy('next_run_at', 'asc')
      .execute();
    return rows.map(toSchedule);
  }

  /**
   * Claims a due schedule by moving its next_run_at forward, but only if it still has the
   * value we read -- so when several server instances poll at once, exactly one of them gets
   * to send it. Returns whether this caller won.
   */
  async claim(id: string, expectedNextRunAt: string, newNextRunAt: string): Promise<boolean> {
    const result = await this.db
      .updateTable('report_schedules')
      .set({ next_run_at: newNextRunAt })
      .where('id', '=', id)
      .where('next_run_at', '=', expectedNextRunAt)
      .executeTakeFirst();
    return (result.numUpdatedRows ?? 0n) > 0n;
  }

  async recordResult(id: string, result: { status: string; error: string | null; sentRunIds?: string[] }): Promise<void> {
    await this.db
      .updateTable('report_schedules')
      .set({
        last_run_at: new Date().toISOString(),
        last_status: result.status,
        last_error: result.error,
        ...(result.sentRunIds ? { last_sent_run_ids: JSON.stringify(result.sentRunIds) } : {}),
      })
      .where('id', '=', id)
      .execute();
  }
}

export type LastEmail = Omit<Selectable<LastEmailTable>, 'recipients'> & { recipients: string[] };

/** The last email Testify sent (or captured): one row, replaced by each new email. */
export class LastEmailRepository {
  constructor(private db: Kysely<Database>) {}

  async record(entry: Omit<LastEmail, 'id' | 'created_at'>): Promise<LastEmail> {
    const row = { ...entry, id: uuidv7(), created_at: new Date().toISOString(), recipients: JSON.stringify(entry.recipients) };
    await this.db.insertInto('last_email').values(row).execute();
    await this.db.deleteFrom('last_email').where('id', '!=', row.id).execute();
    return { ...row, recipients: entry.recipients };
  }

  async find(): Promise<LastEmail | undefined> {
    const row = await this.db.selectFrom('last_email').selectAll().orderBy('created_at', 'desc').executeTakeFirst();
    return row ? { ...row, recipients: parseList<string>(row.recipients) } : undefined;
  }
}
