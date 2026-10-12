import type { Kysely } from 'kysely';

/**
 * Report schedules store their sections as JSON text, e.g. `[{"kind":"latest_run","plan_id":"..."}]`.
 * The API now names plan ids `test_plan_id` everywhere, so stored sections are rewritten to match.
 */
async function renameSectionKey(db: Kysely<any>, from: string, to: string): Promise<void> {
  const rows = await db.selectFrom('report_schedules').select(['id', 'sections']).execute();
  for (const row of rows) {
    let sections: unknown;
    try {
      sections = JSON.parse(row.sections);
    } catch {
      continue; // leave anything unreadable as it is
    }
    if (!Array.isArray(sections)) continue;
    let changed = false;
    const renamed = sections.map((section) => {
      if (!section || typeof section !== 'object' || !(from in section)) return section;
      changed = true;
      const { [from]: value, ...rest } = section as Record<string, unknown>;
      return { ...rest, [to]: value };
    });
    if (changed) {
      await db.updateTable('report_schedules').set({ sections: JSON.stringify(renamed) }).where('id', '=', row.id).execute();
    }
  }
}

export async function up(db: Kysely<any>): Promise<void> {
  await renameSectionKey(db, 'plan_id', 'test_plan_id');
}

export async function down(db: Kysely<any>): Promise<void> {
  await renameSectionKey(db, 'test_plan_id', 'plan_id');
}
