import type { RunSummaryReport } from './types.js';
import { renderRunSummaryMarkdown } from './markdown.js';

/**
 * Report emails: report JSON (exactly what the report API returns) rendered as an email that
 * works in mail clients -- light theme, inline styles, tables, no scripts or images -- plus a
 * plain-text version. Every string that comes from users or CI (case titles, failure
 * messages, notes, suite/plan/run names) is HTML-escaped.
 */

export interface EmailSection {
  reportId: string;
  data: any;
  /** Link to this report in the Testify UI, or null when no public URL is configured. */
  url: string | null;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const MAX_ROWS = 25;

const C = {
  text: '#0f172a',
  muted: '#64748b',
  border: '#e2e8f0',
  head: '#f8fafc',
  link: '#0369a1',
  passed: '#16a34a',
  failed: '#dc2626',
  blocked: '#d97706',
  skipped: '#9333ea',
  untested: '#94a3b8',
  other: '#64748b',
};

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const pct = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${Math.round(n * 1000) / 10}%`);
const clip = (s: string | null | undefined, max = 200) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

function h2(title: string, url: string | null): string {
  const link = url ? ` <a href="${escapeHtml(url)}" style="font-size:12px;font-weight:normal;color:${C.link}">Open in Testify →</a>` : '';
  return `<h2 style="font-size:17px;margin:28px 0 8px;color:${C.text}">${escapeHtml(title)}${link}</h2>`;
}

function p(html: string, muted = false): string {
  return `<p style="margin:4px 0;font-size:13px;color:${muted ? C.muted : C.text}">${html}</p>`;
}

function table(headers: string[], rows: string[][]): string {
  const th = headers.map((h) => `<th style="text-align:left;font-size:11px;color:${C.muted};text-transform:uppercase;padding:6px 8px;border-bottom:1px solid ${C.border};background:${C.head}">${escapeHtml(h)}</th>`).join('');
  const body = rows
    .map((r) => `<tr>${r.map((cell) => `<td style="font-size:13px;color:${C.text};padding:6px 8px;border-bottom:1px solid ${C.border};vertical-align:top">${cell}</td>`).join('')}</tr>`)
    .join('');
  return `<table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;margin:6px 0 4px">${`<tr>${th}</tr>`}${body}</table>`;
}

function more(total: number, shown: number, url: string | null): string {
  if (total <= shown) return '';
  return p(`…and ${total - shown} more${url ? ` — <a href="${escapeHtml(url)}" style="color:${C.link}">see all in Testify</a>` : ''}.`, true);
}

function verdictColor(v: string | null | undefined): string {
  switch (v) {
    case 'PASSED': return C.passed;
    case 'FAILED': return C.failed;
    case 'BLOCKED': return C.blocked;
    case 'SKIPPED': return C.skipped;
    case null: case undefined: case 'UNTESTED': return C.untested;
    default: return C.other;
  }
}

function verdict(v: string | null | undefined): string {
  const label = v ?? 'UNTESTED';
  return `<span style="color:${verdictColor(label)};font-weight:bold;font-size:12px">${escapeHtml(label)}</span>`;
}

function caseCell(c: { external_id: string; title: string; suite_path?: string | null }): string {
  const suite = c.suite_path ? `<br><span style="font-size:11px;color:${C.muted}">${escapeHtml(c.suite_path)}</span>` : '';
  return `<span style="font-family:monospace;color:${C.link}">${escapeHtml(c.external_id)}</span> ${escapeHtml(c.title)}${suite}`;
}

/** Stacked verdict bar as table cells (works in every mail client). */
function verdictBar(s: { total: number; passed: number; failed: number; blocked: number; skipped: number; untested: number; other: number }): string {
  if (!s.total) return '';
  const parts: Array<[string, number]> = [
    [C.passed, s.passed],
    [C.failed, s.failed],
    [C.blocked, s.blocked],
    [C.skipped, s.skipped],
    [C.other, s.other],
    [C.untested, s.untested],
  ];
  const cells = parts
    .filter(([, n]) => n > 0)
    .map(([color, n]) => `<td style="background:${color};height:8px;width:${((n / s.total) * 100).toFixed(2)}%;font-size:0;line-height:0">&nbsp;</td>`)
    .join('');
  return `<table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;margin:6px 0"><tr>${cells}</tr></table>`;
}

function counts(s: { passed: number; failed: number; blocked: number; skipped: number; untested: number; other: number }): string {
  const items = [`${s.passed} passed`, `${s.failed} failed`, `${s.blocked} blocked`, `${s.skipped} skipped`, `${s.untested} untested`];
  if (s.other) items.push(`${s.other} other`);
  return items.join(' · ');
}

// ---------------------------------------------------------------------------------------
// Per-report renderers: { title, html, text }

function renderRunSummary(r: RunSummaryReport, url: string | null) {
  const s = r.summary;
  const title = `Run: ${r.run.name} (plan ${r.run.plan_name})`;
  const parts = [h2(title, url)];
  parts.push(p(`<b style="font-size:20px">${pct(s.pass_rate)}</b> pass rate · ${s.total - s.untested}/${s.total} executed (${pct(s.completion)})${r.run.status === 'CLOSED' ? ' · run closed' : ''}`));
  parts.push(verdictBar(s));
  parts.push(p(escapeHtml(counts(s)), true));
  if (r.filter_applied) parts.push(p('Limited to a subset of cases.', true));

  const failureById = new Map(r.failures.map((f) => [f.test_case_id, f]));
  const failureRows = (ids: string[]) =>
    ids
      .map((id) => failureById.get(id))
      .filter((f): f is NonNullable<typeof f> => Boolean(f))
      .slice(0, MAX_ROWS)
      .map((f) => [
        caseCell(f) + (f.flaky ? ` <span style="color:${C.blocked};font-size:11px">(flaky)</span>` : ''),
        verdict(f.verdict),
        f.failing_since ? `${escapeHtml(f.failing_since.run_name)}<br><span style="font-size:11px;color:${C.muted}">${f.failing_since.runs} run${f.failing_since.runs === 1 ? '' : 's'}</span>` : '—',
        `<span style="color:${C.failed}">${escapeHtml(clip(f.failure_message || f.notes)) || '—'}</span>`,
      ]);

  if (r.compared_to) {
    const c = r.diff.counts;
    parts.push(
      p(
        `Since <b>${escapeHtml(r.compared_to.name)}</b>: <b style="color:${c.new_failure ? C.failed : C.text}">${c.new_failure} new failure${c.new_failure === 1 ? '' : 's'}</b> · ` +
          `<span style="color:${c.fixed ? C.passed : C.text}">${c.fixed} fixed</span> · ${c.still_failing} still failing · ${c.not_run} not run`
      )
    );
    const newIds = r.diff.cases.new_failure.map((x) => x.test_case_id);
    if (newIds.length) {
      parts.push(`<h3 style="font-size:14px;margin:16px 0 4px;color:${C.failed}">New failures</h3>`);
      parts.push(table(['Case', 'Verdict', 'Failing since', 'Error'], failureRows(newIds)));
      parts.push(more(c.new_failure, Math.min(newIds.length, MAX_ROWS), url));
    }
    const stillIds = r.diff.cases.still_failing.map((x) => x.test_case_id);
    if (stillIds.length) {
      parts.push(`<h3 style="font-size:14px;margin:16px 0 4px;color:${C.blocked}">Still failing</h3>`);
      parts.push(table(['Case', 'Verdict', 'Failing since', 'Error'], failureRows(stillIds)));
      parts.push(more(c.still_failing, Math.min(stillIds.length, MAX_ROWS), url));
    }
    if (r.diff.cases.fixed.length) {
      parts.push(`<h3 style="font-size:14px;margin:16px 0 4px;color:${C.passed}">Fixed</h3>`);
      parts.push(r.diff.cases.fixed.slice(0, MAX_ROWS).map((x) => p(caseCell(x))).join(''));
      parts.push(more(c.fixed, Math.min(r.diff.cases.fixed.length, MAX_ROWS), url));
    }
  } else if (r.failures.length) {
    parts.push(`<h3 style="font-size:14px;margin:16px 0 4px;color:${C.failed}">Failures</h3>`);
    parts.push(table(['Case', 'Verdict', 'Failing since', 'Error'], failureRows(r.failures.map((f) => f.test_case_id))));
    parts.push(more(s.failed + s.blocked, Math.min(r.failures.length, MAX_ROWS), url));
  } else {
    parts.push(p('No failing or blocked cases. ✅'));
  }

  const shortSubject = `Run ${r.run.name}: ${pct(s.pass_rate)} pass${r.compared_to ? `, ${r.diff.counts.new_failure} new failure${r.diff.counts.new_failure === 1 ? '' : 's'}` : ''}`;
  return { title, shortSubject, html: parts.join(''), text: renderRunSummaryMarkdown(r) };
}

function renderOverview(d: any, url: string | null) {
  const title = 'Project overview';
  const parts = [h2(title, url)];
  const plans = (d.plans ?? []) as any[];
  if (plans.length === 0) parts.push(p('No active test plans.', true));
  else {
    parts.push(
      table(
        ['Plan', 'Latest run', 'Pass rate', 'Executed', 'New failures', 'Fixed'],
        plans.map((pl) => [
          escapeHtml(pl.plan.name),
          pl.latest_run ? escapeHtml(pl.latest_run.name) + (pl.latest_run.status === 'CLOSED' ? ` <span style="color:${C.muted};font-size:11px">closed</span>` : '') : '<span style="color:#64748b">No runs</span>',
          pl.summary ? `<b>${pct(pl.summary.pass_rate)}</b>` : '—',
          pl.summary ? `${pl.summary.total - pl.summary.untested}/${pl.summary.total}` : '—',
          pl.new_failures === null ? '—' : `<span style="color:${pl.new_failures ? C.failed : C.text};font-weight:${pl.new_failures ? 'bold' : 'normal'}">${pl.new_failures}</span>`,
          pl.fixed === null ? '—' : `<span style="color:${pl.fixed ? C.passed : C.text}">${pl.fixed}</span>`,
        ])
      )
    );
  }
  const s = d.spec ?? {};
  parts.push(p(`${s.total_cases ?? 0} test cases · ${s.drafts_awaiting_approval ?? 0} drafts awaiting approval · ${s.never_executed ?? 0} never executed`, true));
  if (d.activity) parts.push(p(`Last ${d.activity.days} days: ${d.activity.total} results recorded (${d.activity.api} automated, ${d.activity.ui} by people)`, true));

  const text = [
    `## ${title}`,
    ...plans.map((pl) =>
      pl.summary
        ? `- ${pl.plan.name}: ${pl.latest_run?.name} — ${pct(pl.summary.pass_rate)} pass, ${pl.summary.total - pl.summary.untested}/${pl.summary.total} executed${pl.new_failures !== null ? `, ${pl.new_failures} new failures, ${pl.fixed} fixed` : ''}`
        : `- ${pl.plan.name}: no runs yet`
    ),
    `${s.total_cases ?? 0} test cases · ${s.drafts_awaiting_approval ?? 0} drafts awaiting approval · ${s.never_executed ?? 0} never executed`,
  ].join('\n');
  return { title, shortSubject: 'Project overview', html: parts.join(''), text };
}

function renderTestHealth(d: any, url: string | null) {
  const title = `Test health (plan ${d.plan?.name ?? ''})`;
  const parts = [h2(title, url), p(`Last ${d.runs_analysed?.length ?? 0} runs.`, true)];
  const lists: Array<[string, string, (r: any) => string]> = [
    ['flaky', 'Flaky', (r) => `flip score ${Number(r.flip_score).toFixed(2)}${r.passed_on_retry_runs ? `, passed on retry in ${r.passed_on_retry_runs} run(s)` : ''}`],
    ['always_failing', 'Always failing', (r) => `${r.consecutive_failures} runs in a row${r.last_failure_message ? ` — <span style="color:${C.failed}">${escapeHtml(clip(r.last_failure_message, 140))}</span>` : ''}`],
    ['slowing', 'Getting slower', (r) => `${Number(r.slowdown).toFixed(2)}× slower`],
    ['slowest', 'Slowest', (r) => `${Math.round(r.median_ms)} ms median`],
    ['stale', 'Stale', (r) => (r.days_since === null ? 'never executed' : `${r.days_since} days since last run`)],
  ];
  const textLines = [`## ${title}`];
  for (const [key, label, detail] of lists) {
    const rows = (d[key] ?? []) as any[];
    const total = d.counts?.[key] ?? rows.length;
    parts.push(`<h3 style="font-size:14px;margin:16px 0 4px;color:${C.text}">${label} (${total})</h3>`);
    if (rows.length === 0) parts.push(p('None.', true));
    else {
      parts.push(table(['Case', 'Detail'], rows.slice(0, 10).map((r) => [caseCell(r), detail(r)])));
      parts.push(more(total, Math.min(rows.length, 10), url));
    }
    textLines.push(`${label}: ${total}`);
  }
  return { title, shortSubject: 'Test health', html: parts.join(''), text: textLines.join('\n') };
}

function renderPlanTrend(d: any, url: string | null) {
  const title = `Plan trend (plan ${d.plan?.name ?? ''})`;
  const points = ([...(d.points ?? [])] as any[]).reverse();
  const parts = [h2(title, url)];
  if (points.length === 0) parts.push(p('No runs yet.', true));
  else
    parts.push(
      table(
        ['Run', 'Pass rate', 'Executed', 'Failing', 'New failures', 'Fixed'],
        points.map((pt) => [
          escapeHtml(pt.run_name),
          `<b>${pct(pt.pass_rate)}</b>`,
          `${pt.total - pt.untested}/${pt.total}`,
          String(pt.failed + pt.blocked),
          pt.new_failures === null ? '—' : String(pt.new_failures),
          pt.fixed === null ? '—' : String(pt.fixed),
        ])
      )
    );
  const text = [`## ${title}`, ...points.map((pt) => `- ${pt.run_name}: ${pct(pt.pass_rate)} pass, ${pt.failed + pt.blocked} failing`)].join('\n');
  return { title, shortSubject: 'Plan trend', html: parts.join(''), text };
}

function renderBreakdown(d: any, url: string | null) {
  const label = d.group_by?.label ?? 'group';
  const title = `Breakdown by ${label}${d.run ? ` (run ${d.run.name})` : ' (plan coverage)'}`;
  const groups = (d.groups ?? []) as any[];
  const verdicts = d.mode === 'verdicts';
  const parts = [h2(title, url)];
  parts.push(
    verdicts
      ? table(
          [label, 'Cases', 'Pass rate', 'Executed', 'Failed', 'Blocked'],
          groups.map((g) => [escapeHtml(g.key), String(g.total), `<b>${pct(g.pass_rate)}</b>`, pct(g.completion), String(g.failed), String(g.blocked)])
        )
      : table(
          [label, 'Cases', 'In plan', 'Coverage'],
          groups.map((g) => [escapeHtml(g.key), String(g.total_cases), String(g.in_plan), `<b>${pct(g.coverage)}</b>`])
        )
  );
  const text = [`## ${title}`, ...groups.map((g) => (verdicts ? `- ${g.key}: ${pct(g.pass_rate)} pass of ${g.total}` : `- ${g.key}: ${g.in_plan}/${g.total_cases} in plan`))].join('\n');
  return { title, shortSubject: `Breakdown by ${label}`, html: parts.join(''), text };
}

const RENDERERS: Record<string, (data: any, url: string | null) => { title: string; shortSubject: string; html: string; text: string }> = {
  run_summary: renderRunSummary,
  overview: renderOverview,
  test_health: renderTestHealth,
  plan_trend: renderPlanTrend,
  breakdown: renderBreakdown,
};

export const EMAILABLE_REPORTS = Object.keys(RENDERERS);

/**
 * One email from one or more report sections. `title` (e.g. a schedule's name) becomes the
 * subject; without it, a single section's own summary does ("Run v1.2: 92% pass, 1 new failure").
 */
export function renderReportEmail(
  sections: EmailSection[],
  opts: { projectName: string; title?: string; message?: string | null; sentBy?: string | null }
): RenderedEmail {
  const rendered = sections.map((s) => {
    const render = RENDERERS[s.reportId];
    if (!render) throw new Error(`Report '${s.reportId}' can't be emailed`);
    return render(s.data, s.url);
  });
  const what = opts.title || (rendered.length === 1 ? rendered[0].shortSubject : 'Test report');
  const subject = `Testify · ${opts.projectName} · ${what}`;

  const message = opts.message?.trim()
    ? `<div style="margin:12px 0;padding:10px 12px;background:${C.head};border-left:3px solid ${C.link};font-size:13px;color:${C.text};white-space:pre-wrap">${escapeHtml(opts.message.trim())}</div>`
    : '';
  const footer = `<p style="margin:28px 0 0;font-size:11px;color:${C.muted}">Sent by Testify${opts.sentBy ? ` on behalf of ${escapeHtml(opts.sentBy)}` : ''}. Numbers are as of ${escapeHtml(new Date().toUTCString())}.</p>`;
  const html =
    `<!doctype html><html><body style="margin:0;padding:0;background:#ffffff">` +
    `<div style="max-width:720px;margin:0 auto;padding:20px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${C.text}">` +
    `<div style="font-size:12px;color:${C.muted};text-transform:uppercase;letter-spacing:0.05em">Testify · ${escapeHtml(opts.projectName)}</div>` +
    `<h1 style="font-size:20px;margin:4px 0 0;color:${C.text}">${escapeHtml(what)}</h1>` +
    message +
    rendered.map((r) => r.html).join('') +
    footer +
    `</div></body></html>`;

  const text = [
    `Testify · ${opts.projectName} · ${what}`,
    opts.message?.trim() ? `\n${opts.message.trim()}` : '',
    ...rendered.map((r, i) => `\n${r.text}${sections[i].url ? `\nOpen in Testify: ${sections[i].url}` : ''}`),
  ].join('\n');

  return { subject, html, text };
}
