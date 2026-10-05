import { createInterface } from 'node:readline/promises';
import { Command, Flags } from '@oclif/core';
import { countPromotions, planByDestination, type DestinationPlan, type GroupMode } from './grouping.js';
import { c, renderVerification, table } from './render.js';
import { resolveOrg, runRunner } from './runner.js';
import { parseStoryList, verifyStories } from './verify.js';

export interface DeployFlags {
  stories: string[];
  'target-org'?: string;
  'git-user'?: string;
  'repo-path'?: string;
  'group-by': string;
  details: boolean;
}

// Shared by `agentia deploy` and `agentia deploy-plan`. In 'plan' mode nothing in Copado is ever changed:
// execute() returns before it reaches promote().
export abstract class DeployBase extends Command {
  static baseFlags = {
    stories: Flags.string({ char: 's', required: true, multiple: true, description: 'User story names (comma-separated, or repeat the flag)' }),
    'target-org': Flags.string({ char: 'o', description: 'Copado org alias or username (default: sf target-org)' }),
    'git-user': Flags.string({ env: 'CCV_GIT_USER', description: 'GitHub account git should use for the pipeline repo' }),
    'repo-path': Flags.string({ description: 'Use an existing local clone of the pipeline repo instead of the temp clone' }),
    'group-by': Flags.string({
      options: ['project', 'env'],
      default: 'project',
      description: 'How stories are split into promotions: "project" (project + credential, default) or "env" (one promotion per source environment, even across projects)',
    }),
    details: Flags.boolean({ description: 'Print the full per-story card (every field) after the table' }),
  };

  protected async execute(flags: DeployFlags, mode: 'plan' | 'deploy', yes: boolean): Promise<void> {
    const stories = parseStoryList(flags.stories);
    const org = resolveOrg(flags['target-org']);

    this.log(c.dim(`Org ${org} | ${stories.length} stor${stories.length === 1 ? 'y' : 'ies'}`));

    const result = await verifyStories(stories, org, undefined, { gitUser: flags['git-user'], repoPath: flags['repo-path'] });

    if (!result.fatal) for (const line of renderVerification(result, flags.details)) this.log(line);

    if (result.fatal) {
      this.log(`\n${c.red('Error:')} ${result.fatal}`);
      process.exitCode = 1;
      return;
    }

    const entries = result.evaluations.flatMap((e) => (e.eligible && e.entry ? [e.entry] : []));
    if (entries.length === 0) {
      this.log(`\n${c.red('Nothing to deploy:')} no story is promotable.`);
      process.exitCode = 1;
      return;
    }

    const excluded = stories.length - entries.length;
    const groupMode = flags['group-by'] as GroupMode;
    const plans = planByDestination(entries, groupMode);
    this.printPlan(plans, excluded, groupMode);

    if (mode === 'plan') {
      const other: GroupMode = groupMode === 'project' ? 'env' : 'project';
      const otherCount = countPromotions(planByDestination(entries, other));
      const thisCount = countPromotions(plans);
      const extra = [
        flags['target-org'] ? `--target-org ${flags['target-org']}` : '',
        flags['git-user'] ? `--git-user ${flags['git-user']}` : '',
        flags['repo-path'] ? `--repo-path ${flags['repo-path']}` : '',
      ].filter(Boolean);
      const command = (m: GroupMode): string =>
        ['agentia deploy', `-s ${entries.map((e) => e.name).join(',')}`, ...(m === 'env' ? ['--group-by env'] : []), ...extra].join(' ');

      this.log('');
      if (otherCount === thisCount) {
        this.log(c.paleYellow(`Grouped by ${groupMode}: ${thisCount} promotion(s) - grouping by ${other} gives the same result, so no --group-by flag is needed.`));
      } else {
        this.log(c.paleYellow(`Grouped by ${groupMode}: ${thisCount} promotion(s). Grouping by ${other} would give ${otherCount}. Deploy that way: ${command(other)}`));
      }
      this.log(c.paleYellow(`Deploy this plan: ${command(groupMode)}   (add --yes to skip the confirmation prompt)`));
      this.log('');
      this.log(c.dim('Plan only - nothing was changed.'));
      process.exitCode = excluded > 0 ? 1 : 0;
      return;
    }

    if (!yes) {
      if (!process.stdin.isTTY) {
        this.log(`\n${c.red('Refusing to deploy without confirmation.')} Run in a terminal, or pass --yes.`);
        process.exitCode = 1;
        return;
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await rl.question('\nTrigger Merge & Deploy for the plan above? [y/N] ')).trim().toLowerCase();
      rl.close();
      if (answer !== 'y' && answer !== 'yes') {
        this.log('Cancelled. Nothing was changed.');
        return;
      }
    }

    const failed = await this.promote(plans, org);
    if (excluded > 0) this.log(c.yellow(`\n${excluded} story(ies) were not promotable and were left out.`));
    process.exitCode = failed || excluded > 0 ? 1 : 0;
  }

  private printPlan(plans: DestinationPlan[], excluded: number, groupMode: GroupMode): void {
    const modeLabel = groupMode === 'env' ? 'source environment' : 'project';
    this.log(
      `\n${c.bold('Promotion plan')}  ${c.dim(`(grouped by ${modeLabel})`)}${excluded > 0 ? c.yellow(`  (${excluded} story(ies) excluded)`) : ''}`,
    );
    const rows: string[][] = [];
    const groupStarts = new Set<number>();
    const notes: string[] = [];
    let n = 0;

    for (const plan of plans) {
      for (const { group: g, entries, projectNames } of plan.groups) {
        n += 1;
        groupStarts.add(rows.length);
        let action: string;
        let basis: string;
        if (g.retriggerPromotionId) {
          action = g.deployOnly ? c.cyan(`DEPLOY ${g.retriggerPromotionName}`) : c.cyan(`RE-TRIGGER ${g.retriggerPromotionName}`);
          basis = c.dim('existing promotion');
        } else {
          action = c.green('NEW');
          basis = groupMode === 'env' ? `env ${g.sourceEnvName ?? '?'}` : `project ${projectNames.join(', ') || '-'}`;
        }
        entries.forEach((e, i) => {
          rows.push([
            i === 0 ? c.bold(String(n)) : '',
            i === 0 ? action : '',
            i === 0 ? basis : '',
            c.bold(e.name),
            c.yellow(e.sourceEnvName ?? '?'),
            e.projectName || '-',
            plan.destination || '(pipeline default)',
          ]);
        });

        if (!g.retriggerPromotionId && g.projectId === null && projectNames.length > 1) {
          notes.push(`Promotion ${n}: stories span ${projectNames.length} projects - Promotion.Project is left blank`);
        }
        const inRun = new Set(g.stories.map((s) => s.toUpperCase()));
        const absent = new Set<string>();
        for (const e of entries) for (const sib of e.siblingStories ?? []) if (!inRun.has(sib.name.toUpperCase())) absent.add(sib.name);
        if (absent.size > 0) notes.push(`${g.retriggerPromotionName} also contains ${[...absent].join(', ')} (not in this run)`);
      }
    }

    for (const line of table(['#', 'Action', 'Grouped by', 'Story', 'Source env', 'Project', 'Destination'], rows, { groupStarts })) this.log(line);
    for (const note of notes) this.log(c.yellow(`! ${note}`));
  }

  private async promote(plans: DestinationPlan[], org: string): Promise<boolean> {
    let failed = false;
    const names = new Map<string, string>();

    for (const plan of plans) {
      this.log(`\n${c.bold(`Promoting to ${plan.destination || 'pipeline default'}...`)}`);
      await runRunner(
        ['--target-org', org, '--promote', 'true', '--groups', JSON.stringify(plan.groups.map((g) => g.group)), '--merge-deploy', 'true'],
        (ev) => {
          switch (ev.type) {
            case 'promotion-created':
            case 'promotion-retriggered':
              names.set(ev.promotionId, ev.promotionName);
              this.log(`  ${ev.type === 'promotion-created' ? 'Created' : 'Re-triggering'} promotion ${c.bold(ev.promotionName)} (${ev.storyCount} stor${ev.storyCount === 1 ? 'y' : 'ies'})`);
              break;
            case 'promote-result':
              if (ev.success) this.log(`    ${c.green('v')} ${ev.storyName}`);
              else {
                failed = true;
                this.log(`    ${c.red('x')} ${ev.storyName}: ${ev.error}`);
              }
              break;
            case 'promote-phase':
              this.log(`  ${c.dim(ev.label)}`);
              break;
            case 'merge-deploy-started':
              this.log(`  ${c.green('v')} ${ev.deployOnly ? 'Deploy' : 'Merge & Deploy'} queued for ${names.get(ev.promotionId) ?? ev.promotionId}`);
              break;
            case 'merge-deploy-error':
              failed = true;
              this.log(`  ${c.red('x')} Merge & Deploy failed for ${names.get(ev.promotionId) ?? ev.promotionId}: ${ev.error}`);
              break;
            case 'promote-summary':
              for (const s of ev.promotionSummary ?? []) if (!s.success) failed = true;
              break;
            case 'fatal':
              failed = true;
              this.log(`  ${c.red('Error:')} ${ev.message}`);
              break;
            default:
              break;
          }
        },
      );
    }

    this.log(
      failed
        ? `\n${c.red('Finished with errors.')}`
        : `\n${c.green('Done.')} ${c.dim('Merge & Deploy jobs are queued in Copado; this command does not wait for them to finish.')}`,
    );
    return failed;
  }
}
