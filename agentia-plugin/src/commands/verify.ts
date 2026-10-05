import { Command, Flags } from '@oclif/core';
import { resolveOrg } from '../lib/runner.js';
import { c, renderVerification } from '../lib/render.js';
import { parseStoryList, verifyStories } from '../lib/verify.js';

export default class Verify extends Command {
  static summary = 'Verify Copado User Stories for promotion (Copado Commit Validator)';
  static description =
    'Checks each story branch against Copado: unregistered commits, metadata coverage, tests, PR approval, dependencies and existing promotions. Exits non-zero if any story is not promotable.';
  static examples = ['<%= config.bin %> verify -s US-0031309', '<%= config.bin %> verify -s US-0031309,US-0031310 --target-org MyOrg'];
  static flags = {
    stories: Flags.string({ char: 's', required: true, multiple: true, description: 'User story names (comma-separated, or repeat the flag)' }),
    'target-org': Flags.string({ char: 'o', description: 'Copado org alias or username (default: sf target-org)' }),
    'git-user': Flags.string({ env: 'CCV_GIT_USER', description: 'GitHub account git should use for the pipeline repo (when your default git account has no access)' }),
    'repo-path': Flags.string({ description: 'Use an existing local clone of the pipeline repo instead of the temp clone' }),
    details: Flags.boolean({ description: 'Print the full per-story card (every field) after the table' }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Verify);
    const stories = parseStoryList(flags.stories);
    const org = resolveOrg(flags['target-org']);

    this.log(c.dim(`Org ${org} | ${stories.length} stor${stories.length === 1 ? 'y' : 'ies'}`));

    const result = await verifyStories(stories, org, undefined, { gitUser: flags['git-user'], repoPath: flags['repo-path'] });

    if (!result.fatal) for (const line of renderVerification(result, flags.details)) this.log(line);

    if (result.fatal) {
      this.log(`\n${c.red('Error:')} ${result.fatal}`);
      if (/not found|authentication|could not read/i.test(result.fatal)) {
        this.log(c.dim('Hint: git could not authenticate to the pipeline repo. Use --git-user <github-account> (or CCV_GIT_USER), or --repo-path <existing clone>.'));
      }
      process.exitCode = 1;
      return;
    }
    const anyNotPromotable =
      result.evaluations.some((e) => !e.eligible) || result.storyErrors.length > 0 || result.notReturned.length > 0;
    if (anyNotPromotable) process.exitCode = 1;
  }
}
