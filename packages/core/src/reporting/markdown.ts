import type { RunSummaryReport, ReportDiffCase, ReportFailure } from './types.js';

function pct(n: number): string {
  return `${Math.round(n * 1000) / 10}%`;
}

function mdCell(s: string | null | undefined, max = 160): string {
  if (!s) return '';
  const oneLine = s.replace(/\s+/g, ' ').trim();
  const clipped = oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
  return clipped.replace(/\|/g, '\\|');
}

function failureTable(rows: ReportFailure[]): string[] {
  const out = ['| Case | Title | Verdict | Failing since | Error |', '|---|---|---|---|---|'];
  for (const f of rows) {
    const since = f.failing_since ? `${mdCell(f.failing_since.run_name, 40)} (${f.failing_since.runs} run${f.failing_since.runs === 1 ? '' : 's'})` : '';
    out.push(
      `| ${mdCell(f.external_id, 40)} | ${mdCell(f.title, 80)}${f.flaky ? ' ⚠️ flaky' : ''} | ${f.verdict} | ${since} | ${mdCell(f.failure_message || f.notes)} |`
    );
  }
  return out;
}

function caseList(rows: ReportDiffCase[]): string[] {
  return rows.map((c) => `- ${mdCell(c.external_id, 40)} ${mdCell(c.title, 100)}${c.verdict ? ` (${c.verdict})` : ''}`);
}

/**
 * A run summary as Markdown -- headline, comparison with the previous run, then the
 * failures. Meant for pasting into a PR comment, chat message or ticket (e.g. by an agent).
 */
export function renderRunSummaryMarkdown(r: RunSummaryReport): string {
  const s = r.summary;
  const executed = s.total - s.untested;
  const lines: string[] = [];
  lines.push(`## Test run "${r.run.name}" (plan "${r.run.plan_name}")`);
  lines.push('');
  lines.push(
    `**Pass rate ${pct(s.pass_rate)}** · ${executed}/${s.total} executed (${pct(s.completion)}) · ` +
      `${s.passed} passed · ${s.failed} failed · ${s.blocked} blocked · ${s.skipped} skipped · ${s.untested} untested` +
      (s.other ? ` · ${s.other} other` : '') +
      (r.run.status === 'CLOSED' ? ' · run closed' : '')
  );
  if (r.filter_applied) lines.push('', '_Filtered to a subset of cases._');

  if (r.compared_to) {
    const c = r.diff.counts;
    lines.push('');
    lines.push(
      `Compared with "${r.compared_to.name}": **${c.new_failure} new failure${c.new_failure === 1 ? '' : 's'}** · ` +
        `${c.fixed} fixed · ${c.still_failing} still failing · ${c.not_run} not run` +
        (c.added || c.removed ? ` · ${c.added} added · ${c.removed} removed` : '')
    );
    const newFailures = r.failures.filter((f) => r.diff.cases.new_failure.some((n) => n.test_case_id === f.test_case_id));
    if (newFailures.length > 0) lines.push('', '### New failures', '', ...failureTable(newFailures));
    if (r.diff.cases.fixed.length > 0) lines.push('', '### Fixed', '', ...caseList(r.diff.cases.fixed));
    const still = r.failures.filter((f) => r.diff.cases.still_failing.some((n) => n.test_case_id === f.test_case_id));
    if (still.length > 0) lines.push('', '### Still failing', '', ...failureTable(still));
    if (r.diff.cases.not_run.length > 0) lines.push('', '### Not run this time', '', ...caseList(r.diff.cases.not_run));
  } else if (r.failures.length > 0) {
    lines.push('', '### Failures', '', ...failureTable(r.failures));
  }

  if (r.failures_truncated || r.diff.truncated) lines.push('', '_Some lists were truncated; raise `limit` for more._');
  const commits = [...new Set(r.runners.map((x) => x.commit_sha).filter(Boolean))];
  if (commits.length > 0) lines.push('', `Commits: ${commits.map((c) => `\`${c.slice(0, 12)}\``).join(', ')}`);
  return lines.join('\n') + '\n';
}
