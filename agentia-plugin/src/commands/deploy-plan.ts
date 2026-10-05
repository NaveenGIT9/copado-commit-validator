import { DeployBase } from '../lib/deployBase.js';

export default class DeployPlan extends DeployBase {
  static summary = 'Verify stories and show how promotions would be created, without changing anything';
  static description =
    'Runs the same verification as "deploy" and prints the promotion plan (which stories go into which promotion, grouped by project or source environment). Never creates or changes anything in Copado. Prints the exact "deploy" command to run for the plan.';
  static examples = [
    '<%= config.bin %> deploy-plan -s US-0031309,US-0031310',
    '<%= config.bin %> deploy-plan -s US-0031309,US-0031310 --group-by env',
  ];

  async run(): Promise<void> {
    const { flags } = await this.parse(DeployPlan);
    await this.execute(flags, 'plan', false);
  }
}
