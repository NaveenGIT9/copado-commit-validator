import { Flags } from '@oclif/core';
import { DeployBase } from '../lib/deployBase.js';

export default class Deploy extends DeployBase {
  static summary = 'Verify stories, then promote the promotable ones with Merge & Deploy (Copado Commit Validator)';
  static description =
    'Verifies the stories, builds promotions the same way the Copado Commit Validator panel does, then triggers Merge & Deploy. Stories already in a "Conflicts Resolved" promotion re-trigger that promotion instead of creating a new one. Asks for confirmation unless --yes is given. To see the plan without changing anything, use "deploy-plan".';
  static examples = [
    '<%= config.bin %> deploy -s US-0031309,US-0031310',
    '<%= config.bin %> deploy -s US-0031309,US-0031310 --group-by env',
    '<%= config.bin %> deploy -s US-0031309 --yes',
  ];
  static flags = {
    yes: Flags.boolean({ char: 'y', description: 'Skip the confirmation prompt' }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Deploy);
    await this.execute(flags, 'deploy', flags.yes);
  }
}
