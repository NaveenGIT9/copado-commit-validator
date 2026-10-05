import { exec } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

// The agentia plugin (adds `agentia verify`, `agentia deploy-plan`, `agentia deploy`) lives in the
// agentia-plugin/ folder of this same repo. agentia can only install a plugin from a repo root, so this
// command clones the repo into a private folder, builds the plugin there and links it into agentia.
const REPO_URL = 'https://github.com/NaveenGIT9/copado-commit-validator.git';
const BRANCH = 'feature/v2.0';
const PLUGIN_NAME = '@naveengit9/agentia-ccv';
const AGENTIA_CLI_INSTALL = 'npm install -g @copado/agentia-cli';

let output: vscode.OutputChannel | undefined;

function sh(commandLine: string, cwd?: string): Promise<{ ok: boolean; stdout: string }> {
  output?.appendLine(`> ${commandLine}`);
  return new Promise((resolve) => {
    exec(
      commandLine,
      {
        cwd,
        timeout: 600_000,
        windowsHide: true,
        maxBuffer: 20 * 1024 * 1024,
        // Never block on a credential prompt; VS Code's own git credentials still apply via GIT_ASKPASS.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (error, stdout, stderr) => {
        if (stdout?.trim()) output?.appendLine(stdout.trimEnd());
        if (stderr?.trim()) output?.appendLine(stderr.trimEnd());
        resolve({ ok: !error, stdout: String(stdout ?? '') });
      },
    );
  });
}

async function fail(message: string): Promise<void> {
  const choice = await vscode.window.showErrorMessage(message, 'Show output');
  if (choice === 'Show output') output?.show(true);
}

export async function installAgentiaCommands(): Promise<void> {
  output ??= vscode.window.createOutputChannel('agentia commands install');
  output.clear();
  output.show(true);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Installing agentia commands' },
    async (progress) => {
      const step = (message: string): void => progress.report({ message });

      step('Checking agentia, git and npm...');
      if (!(await sh('agentia --version')).ok) {
        const choice = await vscode.window.showErrorMessage(
          `The agentia CLI was not found. Install it first (${AGENTIA_CLI_INSTALL}), then run this command again.`,
          'Install agentia CLI',
        );
        if (choice === 'Install agentia CLI') {
          const terminal = vscode.window.createTerminal('agentia CLI');
          terminal.show();
          terminal.sendText(AGENTIA_CLI_INSTALL);
        }
        return;
      }
      if (!(await sh('git --version')).ok) return fail('git was not found on your PATH.');
      if (!(await sh('npm --version')).ok) return fail('npm (Node.js) was not found on your PATH.');

      const sourceDir = path.join(os.homedir(), '.copado-ccv', 'agentia-ccv-src');
      const pluginDir = path.join(sourceDir, 'agentia-plugin');

      if (fs.existsSync(path.join(sourceDir, '.git'))) {
        step('Updating the plugin source...');
        const fetched = await sh(`git fetch --depth 1 origin ${BRANCH}`, sourceDir);
        if (!fetched.ok || !(await sh('git reset --hard FETCH_HEAD', sourceDir)).ok) {
          return fail('Could not update the plugin source. See the output for details.');
        }
      } else {
        step('Downloading the plugin source...');
        fs.mkdirSync(path.dirname(sourceDir), { recursive: true });
        if (!(await sh(`git clone --depth 1 --branch ${BRANCH} "${REPO_URL}" "${sourceDir}"`)).ok) {
          return fail(
            'Could not download the plugin source. Make sure git can access the repo (sign in to GitHub), then try again.',
          );
        }
      }

      step('Installing dependencies...');
      if (!(await sh('npm install --no-audit --no-fund', pluginDir)).ok) return fail('npm install failed. See the output for details.');

      step('Building the plugin...');
      if (!(await sh('npm run build', pluginDir)).ok) return fail('Building the plugin failed. See the output for details.');

      step('Linking into agentia...');
      if (!(await sh(`agentia plugins link "${pluginDir}"`)).ok) return fail('agentia could not link the plugin. See the output for details.');

      const listed = await sh('agentia plugins');
      if (!listed.stdout.includes(PLUGIN_NAME)) return fail('The plugin was linked but is not listed by agentia. See the output for details.');

      void vscode.window.showInformationMessage(
        'agentia commands installed. Try: agentia verify -s <story>   (also: deploy-plan, deploy)',
      );
    },
  );
}
