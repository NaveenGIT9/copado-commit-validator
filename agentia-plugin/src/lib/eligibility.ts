import type { RunnerEvent } from './runner.js';

// Ported from vscode-extension/webview/index.html (`story-verified` handler) so the
// terminal makes the same promote / re-trigger / blocked decision as the panel.

export type Outcome = 'promote' | 'retrigger' | 'deploy-only' | 'blocked' | 'in-progress';

export interface PromoteEntry {
  name: string;
  id: string;
  projectId: string | null;
  credentialId: string;
  projectName: string;
  sourceEnvName: string | null;
  dstEnvName: string | null;
  dstEnvDisplayName: string | null;
  developer: string;
  retriggerPromotionId?: string;
  retriggerPromotionName?: string;
  siblingStories?: Array<{ name: string }>;
  deployOnly?: boolean;
  mergeConflictNote?: string;
}

export interface Evaluation {
  storyName: string;
  eligible: boolean;
  outcome: Outcome;
  blockers: string[];
  warnings: string[];
  entry?: PromoteEntry;
}

const ELIGIBLE_VERDICTS = ['clean', 'skip-covered-same-author', 'skip-needs-verify'];

const VERDICT_REASON: Record<string, string> = {
  'skip-unregistered': 'Unregistered commits touch components not tracked on the story',
  'branch-not-found': 'Feature branch no longer exists',
};

export function evaluateStory(ev: RunnerEvent): Evaluation {
  const tests: Array<{ status?: string; type?: string; tool?: string; name?: string }> = ev.tests ?? [];
  const failedTests = tests.filter((t) => t.status === 'Failed' || t.status === 'Error');
  const prBlocked = Boolean(ev.hasMetadata) && !ev.prApproved;
  const hasApexTest = tests.some((t) => /apex/i.test(t.type ?? '') || /apex/i.test(t.tool ?? '') || /apex/i.test(t.name ?? ''));
  const noApexTestClass = ev.hasApexCode !== false && (ev.hasApexMetadata ?? false) && !hasApexTest;
  const parentBlocked = Boolean(ev.parentStory) && !ev.parentStory.promoted;
  const noCommits = ev.verdict === 'skip-no-commits';
  const noCommitsNoTasks = noCommits && !ev.hasDeploymentTasks;
  const dependencies: Array<{ parentAhead?: boolean; parentInSamePromo?: boolean; parentName?: string }> = ev.dependencies ?? [];
  const dependencyBlocked = dependencies.some((d) => !d.parentAhead && !d.parentInSamePromo);
  const xmlTypeMetadata: unknown[] = ev.xmlTypeMetadata ?? [];
  const orgBranchMerges: unknown[] = ev.orgBranchMerges ?? [];

  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!(ELIGIBLE_VERDICTS.includes(ev.verdict) || noCommits)) {
    blockers.push(ev.verdict === 'error' && ev.message ? String(ev.message) : (VERDICT_REASON[ev.verdict] ?? `Verdict: ${ev.verdict}`));
  }
  if (noCommitsNoTasks) blockers.push('No commits and no deployment tasks');
  if (failedTests.length > 0) blockers.push(`Failed tests: ${failedTests.map((t) => t.name ?? t.type ?? 'test').join(', ')}`);
  if (!noCommits && prBlocked) blockers.push('Pull request not approved');
  if (!noCommits && noApexTestClass) blockers.push('Apex metadata present but no Apex test class on the story');
  if (parentBlocked) blockers.push(`Parent story ${ev.parentStory.name} is not promoted yet`);
  if (dependencyBlocked) blockers.push('A dependency is not ahead in the pipeline and not in the same promotion');
  if (xmlTypeMetadata.length > 0) blockers.push('Story has XML-type metadata entries');
  if (orgBranchMerges.length > 0) blockers.push('Org-branch merge detected on the feature branch');

  const base = { storyName: ev.storyName as string, blockers, warnings };
  const eligible = blockers.length === 0;
  if (!eligible) return { ...base, eligible, outcome: 'blocked' };

  const warning = ev.lastPromoWarning ?? null;
  const status: string | undefined = warning?.status;
  const entry: PromoteEntry = {
    name: ev.storyName,
    id: ev.storyId,
    projectId: ev.projectId ?? null,
    credentialId: ev.credentialId,
    projectName: ev.projectName ?? '',
    sourceEnvName: ev.srcEnvName ?? null,
    dstEnvName: ev.dstEnvName ?? null,
    dstEnvDisplayName: ev.dstEnvDisplayName ?? ev.dstEnvName ?? null,
    developer: ev.storyDeveloper ?? '',
  };

  if (!warning || (status === 'Merge Conflict' && warning.isConflictOnCurrentStory === false)) {
    if (warning) warnings.push(`Merge conflict in ${warning.name} was caused by another story; a new promotion will be created`);
    return { ...base, eligible, outcome: 'promote', entry };
  }

  if (status === 'Conflicts Resolved' || status === 'Validated') {
    entry.retriggerPromotionId = warning.id;
    entry.retriggerPromotionName = warning.name;
    entry.siblingStories = warning.siblingStories ?? [];
    if (status === 'Validated') entry.deployOnly = true;
    return { ...base, eligible, outcome: status === 'Validated' ? 'deploy-only' : 'retrigger', entry };
  }

  if (status === 'Completed with errors' || status === 'Validation failed') {
    blockers.push(`Last promotion ${warning.name} ended "${status}" and no fix commit was found`);
    return { ...base, eligible: false, outcome: 'blocked' };
  }

  if (status === 'Merge Conflict') {
    entry.mergeConflictNote = `${warning.name} has an unresolved merge conflict on this story`;
    warnings.push(entry.mergeConflictNote);
    return { ...base, eligible, outcome: 'promote', entry };
  }

  warnings.push(`Promotion ${warning.name ?? ''} is "${status}" - skipped`);
  return { ...base, eligible: false, outcome: 'in-progress' };
}
