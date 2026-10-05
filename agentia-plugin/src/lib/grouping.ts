import type { PromoteEntry } from './eligibility.js';

// Ported from promote() in vscode-extension/webview/index.html. The panel's "View by"
// toggle maps to GroupMode: 'project' (default) groups by project + credential, 'env' groups
// by source environment. Stories re-triggering the same existing promotion always share it.
// The panel's per-story "separate promotion" checkbox is not supported in the CLI.

export type GroupMode = 'project' | 'env';

export interface PromoteGroup {
  projectId: string | null;
  credentialId: string;
  sourceEnvName: string | null;
  stories: string[];
  storyIds: string[];
  storyDevelopers: string[];
  retriggerPromotionId: string | null;
  retriggerPromotionName: string | null;
  deployOnly: boolean;
  conflictResolvedSourcePromoId: string | null;
  conflictResolvedLatestCommit: string | null;
  conflictResolvedPromoLastMod: string | null;
}

export interface PlannedGroup {
  group: PromoteGroup;
  entries: PromoteEntry[];
  projectNames: string[];
}

export interface DestinationPlan {
  destination: string; // real Environment name for display, e.g. RBKUAT
  groups: PlannedGroup[];
}

function groupKey(s: PromoteEntry, mode: GroupMode): string {
  if (s.retriggerPromotionId) return `__retrigger__${s.retriggerPromotionId}`;
  if (mode === 'env') return `__env__${s.sourceEnvName || s.projectId}`;
  return `${s.projectId}::${s.credentialId}`;
}

export function buildGroups(entries: PromoteEntry[], mode: GroupMode): PlannedGroup[] {
  const groupMap = new Map<string, { planned: PlannedGroup; projectIds: Set<string | null> }>();

  for (const s of entries) {
    const key = groupKey(s, mode);
    let slot = groupMap.get(key);
    if (!slot) {
      slot = {
        projectIds: new Set([s.projectId]),
        planned: {
          entries: [],
          projectNames: [],
          group: {
            projectId: s.projectId,
            credentialId: s.credentialId,
            sourceEnvName: s.sourceEnvName,
            stories: [],
            storyIds: [],
            storyDevelopers: [],
            retriggerPromotionId: s.retriggerPromotionId ?? null,
            retriggerPromotionName: s.retriggerPromotionName ?? null,
            deployOnly: s.deployOnly ?? false,
            conflictResolvedSourcePromoId: null,
            conflictResolvedLatestCommit: null,
            conflictResolvedPromoLastMod: null,
          },
        },
      };
      groupMap.set(key, slot);
    } else {
      slot.projectIds.add(s.projectId);
    }
    slot.planned.entries.push(s);
    slot.planned.group.stories.push(s.name);
    slot.planned.group.storyIds.push(s.id);
    slot.planned.group.storyDevelopers.push(s.developer);
    if (s.projectName && !slot.planned.projectNames.includes(s.projectName)) slot.planned.projectNames.push(s.projectName);
  }

  return [...groupMap.values()].map(({ planned, projectIds }) => {
    // Stories from several projects: leave Promotion.Project blank, as the panel does.
    if (projectIds.size > 1) planned.group.projectId = null;
    return planned;
  });
}

// The panel promotes one destination at a time, so the CLI does the same: one runner call per destination.
export function planByDestination(entries: PromoteEntry[], mode: GroupMode): DestinationPlan[] {
  const byDest = new Map<string, PromoteEntry[]>();
  for (const e of entries) {
    const dest = (e.dstEnvName ?? '').toLowerCase();
    byDest.set(dest, [...(byDest.get(dest) ?? []), e]);
  }
  return [...byDest.entries()].map(([key, list]) => ({
    destination: list[0].dstEnvDisplayName ?? key,
    groups: buildGroups(list, mode),
  }));
}

export function countPromotions(plans: DestinationPlan[]): number {
  return plans.reduce((n, p) => n + p.groups.length, 0);
}
