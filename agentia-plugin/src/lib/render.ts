import type { Evaluation } from './eligibility.js';
import type { RunnerEvent } from './runner.js';
import type { VerifyOutcome } from './verify.js';

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code: string) => (s: string): string => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);
export const c = {
  bold: paint('1'),
  dim: paint('2'),
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  blue: paint('34'),
  cyan: paint('36'),
  orange: paint('38;5;208'),
  paleYellow: paint('38;5;229'),
};

const OUTCOME_LABEL: Record<string, (s: string) => string> = {
  promote: (s) => c.green(s),
  retrigger: (s) => c.cyan(s),
  'deploy-only': (s) => c.cyan(s),
  blocked: (s) => c.red(s),
  'in-progress': (s) => c.yellow(s),
};

function outcomeText(ev: Evaluation): string {
  switch (ev.outcome) {
    case 'promote':
      return 'PROMOTABLE';
    case 'retrigger':
      return `PROMOTABLE - re-trigger ${ev.entry?.retriggerPromotionName ?? 'existing promotion'}`;
    case 'deploy-only':
      return `PROMOTABLE - deploy validated ${ev.entry?.retriggerPromotionName ?? 'promotion'}`;
    case 'in-progress':
      return 'SKIPPED - promotion in progress';
    default:
      return 'BLOCKED';
  }
}

function testsText(tests: Array<{ name?: string; status?: string }>): string {
  if (tests.length === 0) return 'none';
  return tests.map((t) => `${t.name ?? 'test'}: ${t.status ?? 'unknown'}`).join(', ');
}

export function renderStory(ev: RunnerEvent, evaluation: Evaluation): string[] {
  const out: string[] = [];
  const label = OUTCOME_LABEL[evaluation.outcome];
  const mark = evaluation.outcome === 'blocked' ? 'x' : evaluation.outcome === 'in-progress' ? '-' : 'v';
  out.push('');
  out.push(`${c.bold(ev.storyName)}  ${label(`${mark} ${outcomeText(evaluation)}`)}`);

  const meta: string[] = [];
  if (ev.storyDeveloper) meta.push(`dev ${ev.storyDeveloper}`);
  if (ev.projectName) meta.push(`project ${ev.projectName}`);
  if (ev.srcEnvName || ev.dstEnvName) meta.push(`${ev.srcEnvName ?? '?'} -> ${ev.dstEnvDisplayName ?? ev.dstEnvName ?? '?'}`);
  if (meta.length) out.push(c.dim(`  ${meta.join('  |  ')}`));

  if (ev.branch) out.push(`  Branch      ${ev.branch}${ev.baseBranch ? c.dim(`  (base ${ev.baseBranch})`) : ''}`);

  const copado: unknown[] = ev.copadoCommits ?? [];
  const extra: unknown[] = ev.extraCommits ?? [];
  const unreg: unknown[] = ev.unregistered ?? [];
  out.push(`  Commits     ${copado.length} registered in Copado, ${extra.length} on branch, ${unreg.length > 0 ? c.red(`${unreg.length} unregistered`) : '0 unregistered'}`);

  const detail: Array<{
    sha: string;
    authorName?: string;
    commitMessage?: string;
    copadoAuto?: boolean;
    authorMismatch?: boolean;
    copadoStatus?: string | null;
    coveredComponents?: string[];
    uncoveredComponents?: string[];
  }> = ev.unregisteredDetail ?? [];
  for (const d of detail) {
    const tags: string[] = [];
    if (d.copadoAuto) tags.push('copado auto-commit');
    if (d.authorMismatch) tags.push('author mismatch');
    if (d.copadoStatus) tags.push(`copado status ${d.copadoStatus}`);
    const msg = (d.commitMessage ?? '').split('\n')[0].slice(0, 70);
    out.push(`    ${c.yellow(d.sha)} ${msg}${d.authorName ? c.dim(`  - ${d.authorName}`) : ''}${tags.length ? c.dim(`  [${tags.join(', ')}]`) : ''}`);
    if (d.uncoveredComponents?.length) out.push(`      ${c.red('not on story:')} ${d.uncoveredComponents.join(', ')}`);
    if (d.coveredComponents?.length) out.push(`      ${c.green('covered:')}    ${d.coveredComponents.join(', ')}`);
  }

  const tests = testsText(ev.tests ?? []);
  out.push(`  Tests       ${tests}`);
  if (ev.hasMetadata !== undefined) out.push(`  PR          ${ev.hasMetadata ? (ev.prApproved ? c.green('approved') : c.red('not approved')) : c.dim('n/a (no metadata)')}`);

  if (ev.parentStory) {
    out.push(`  Parent      ${ev.parentStory.name} ${ev.parentStory.promoted ? c.green('promoted') : c.red('not promoted')}`);
  }
  for (const d of ev.dependencies ?? []) {
    const ok = d.parentAhead || d.parentInSamePromo;
    out.push(`  Dependency  ${d.relationshipType ?? 'depends on'} ${d.parentName ?? ''} ${ok ? c.green('ok') : c.red('parent not ahead')}`);
  }
  if (ev.lastPromoWarning) {
    out.push(`  Last promo  ${ev.lastPromoWarning.name ?? ''} - ${ev.lastPromoWarning.status}`);
  }

  for (const b of evaluation.blockers) out.push(`  ${c.red('x')} ${b}`);
  for (const w of evaluation.warnings) out.push(`  ${c.yellow('!')} ${w}`);
  return out;
}

export function renderSummary(evaluations: Evaluation[], notFound: string[]): string[] {
  const ok = evaluations.filter((e) => e.eligible).length;
  const blocked = evaluations.filter((e) => e.outcome === 'blocked').length + notFound.length;
  const skipped = evaluations.filter((e) => e.outcome === 'in-progress').length;
  const parts = [c.green(`${ok} promotable`), blocked ? c.red(`${blocked} blocked`) : '0 blocked'];
  if (skipped) parts.push(c.yellow(`${skipped} skipped`));
  return ['', `${c.bold('Summary')}  ${parts.join('  |  ')}`];
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

const ANSI = /\u001b\[[0-9;]*m/g;
const visibleLength = (s: string): number => s.replace(ANSI, '').length;
const padCell = (s: string, width: number): string => s + ' '.repeat(Math.max(0, width - visibleLength(s)));

export function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export interface TableOptions {
  // Row indexes (0-based) that start a new group: a separator line is drawn above them.
  groupStarts?: Set<number>;
}

export function table(headers: string[], rows: string[][], options: TableOptions = {}): string[] {
  const widths = headers.map((h, i) => Math.max(visibleLength(h), ...rows.map((r) => visibleLength(r[i] ?? ''))));
  const line = (left: string, mid: string, right: string): string => c.dim(`${left}${widths.map((w) => '─'.repeat(w + 2)).join(mid)}${right}`);
  const bar = c.dim('│');
  const renderRow = (cells: string[]): string => `${bar} ${cells.map((cell, i) => padCell(cell ?? '', widths[i])).join(` ${bar} `)} ${bar}`;

  const out: string[] = [line('┌', '┬', '┐'), renderRow(headers.map((h) => c.bold(h))), line('├', '┼', '┤')];
  rows.forEach((row, idx) => {
    if (idx > 0 && options.groupStarts?.has(idx)) out.push(line('├', '┼', '┤'));
    out.push(renderRow(row));
  });
  out.push(line('└', '┴', '┘'));
  return out;
}

function statusCell(ev: Evaluation): string {
  switch (ev.outcome) {
    case 'promote':
      return c.green('PROMOTABLE');
    case 'retrigger':
      return c.cyan(`RE-TRIGGER ${ev.entry?.retriggerPromotionName ?? ''}`.trim());
    case 'deploy-only':
      return c.cyan(`DEPLOY ${ev.entry?.retriggerPromotionName ?? ''}`.trim());
    case 'in-progress':
      return c.yellow('SKIPPED (in progress)');
    default:
      return c.red('BLOCKED');
  }
}

function testsCell(tests: Array<{ status?: string }>): string {
  if (tests.length === 0) return c.dim('none');
  const failed = tests.filter((t) => t.status === 'Failed' || t.status === 'Error').length;
  if (failed) return c.red(`${failed} failed`);
  const running = tests.filter((t) => t.status !== 'Success').length;
  if (running) return c.yellow(`${running} running`);
  return c.green(`${tests.length} passed`);
}

function prCell(ev: RunnerEvent): string {
  if (!ev.hasMetadata) return c.dim('n/a');
  return ev.prApproved ? c.green('approved') : c.red('not approved');
}

export interface VerifiedStory {
  ev: RunnerEvent;
  evaluation: Evaluation;
}

export function renderStoryTable(stories: VerifiedStory[], missing: Array<{ name: string; reason: string }>): string[] {
  const headers = ['Story', 'Developer', 'Project', 'Source → Dest', 'Reg', 'Branch', 'Unreg', 'Tests', 'PR', 'Status'];
  const rows: string[][] = stories.map(({ ev, evaluation }) => {
    const unreg = (ev.unregistered ?? []).length;
    return [
      c.bold(ev.storyName),
      truncate(ev.storyDeveloper ?? '-', 18),
      truncate(ev.projectName ?? '-', 24),
      `${c.yellow(ev.srcEnvName ?? '?')} → ${ev.dstEnvDisplayName ?? ev.dstEnvName ?? '?'}`,
      String((ev.copadoCommits ?? []).length),
      String((ev.extraCommits ?? []).length),
      unreg > 0 ? c.red(String(unreg)) : '0',
      testsCell(ev.tests ?? []),
      prCell(ev),
      statusCell(evaluation),
    ];
  });
  for (const m of missing) rows.push([c.bold(m.name), '-', '-', '-', '-', '-', '-', '-', '-', c.red(m.reason)]);
  return table(headers, rows);
}

export function renderVerification(result: VerifyOutcome, full: boolean): string[] {
  const stories: VerifiedStory[] = result.verified.map((ev, i) => ({ ev, evaluation: result.evaluations[i] }));
  const missing = [
    ...result.storyErrors.map((e) => ({ name: e.storyName, reason: e.message })),
    ...result.notReturned.map((n) => ({ name: n, reason: 'no result returned' })),
  ];
  return [
    '',
    ...renderStoryTable(stories, missing),
    ...renderStoryDetails(stories, full),
    ...renderSummary(result.evaluations, missing.map((m) => m.name)),
  ];
}

// Only the things worth reading: unregistered commits, blockers, warnings. Pass full=true for every field.
export function renderStoryDetails(stories: VerifiedStory[], full: boolean): string[] {
  const out: string[] = [];
  for (const { ev, evaluation } of stories) {
    if (full) {
      out.push(...renderStory(ev, evaluation));
      continue;
    }
    const unreg: Array<{ sha: string; commitMessage?: string; uncoveredComponents?: string[]; coveredComponents?: string[] }> = ev.unregisteredDetail ?? [];
    if (unreg.length === 0 && evaluation.blockers.length === 0 && evaluation.warnings.length === 0) continue;
    out.push('', c.bold(ev.storyName));
    for (const d of unreg) {
      out.push(`  ${c.yellow(d.sha)} ${(d.commitMessage ?? '').split('\n')[0].slice(0, 70)}`);
      if (d.uncoveredComponents?.length) out.push(`    ${c.red('not on story:')} ${d.uncoveredComponents.join(', ')}`);
      if (d.coveredComponents?.length) out.push(`    ${c.green('covered:')}    ${d.coveredComponents.join(', ')}`);
    }
    for (const b of evaluation.blockers) out.push(`  ${c.red('x')} ${b}`);
    for (const w of evaluation.warnings) out.push(`  ${c.yellow('!')} ${w}`);
  }
  return out;
}
