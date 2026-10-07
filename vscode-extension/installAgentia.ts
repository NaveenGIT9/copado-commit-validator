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
const AGENTIA_CLI_PACKAGE = '@copado/agentia-cli';
const AGENTIA_CLI_INSTALL = `npm install -g ${AGENTIA_CLI_PACKAGE}`;
// Fallback install location when the global npm folder is not writable (e.g. /usr/local on macOS).
const USER_PREFIX = path.join(os.homedir(), '.copado-ccv', 'npm');

let output: vscode.OutputChannel | undefined;

function sh(commandLine: string, cwd?: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
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
        resolve({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
  });
}

// Folder that holds the `agentia` executable for the user-level fallback install.
function userBinDir(): string {
  return process.platform === 'win32' ? USER_PREFIX : path.join(USER_PREFIX, 'bin');
}

// Returns the command to run agentia: plain `agentia` when it is on PATH, else the user-level copy, else undefined.
async function resolveAgentia(): Promise<string | undefined> {
  if ((await sh('agentia --version')).ok) return 'agentia';
  const local = path.join(userBinDir(), process.platform === 'win32' ? 'agentia.cmd' : 'agentia');
  if (fs.existsSync(local) && (await sh(`"${local}" --version`)).ok) return `"${local}"`;
  return undefined;
}

// Installs the agentia CLI. Tries the normal global install; on a permissions error retries into the user's home folder.
async function installAgentiaCli(): Promise<boolean> {
  const first = await sh(AGENTIA_CLI_INSTALL);
  if (first.ok) return true;
  if (!/EACCES|EPERM|permission denied/i.test(first.stderr + first.stdout)) return false;
  output?.appendLine(`The global npm folder is not writable. Installing into ${USER_PREFIX} instead.`);
  fs.mkdirSync(USER_PREFIX, { recursive: true });
  return (await sh(`npm install -g --prefix "${USER_PREFIX}" ${AGENTIA_CLI_PACKAGE}`)).ok;
}

// For the user-level install: offer to put its folder on PATH so `agentia` also works in a plain terminal.
async function offerPathSetup(): Promise<void> {
  const bin = userBinDir();
  if (process.platform === 'win32') {
    void vscode.window.showInformationMessage(`agentia was installed to ${bin}. Add this folder to your PATH to use it in any terminal.`);
    return;
  }
  const rc = path.join(os.homedir(), process.env.SHELL?.endsWith('bash') ? '.bashrc' : '.zshrc');
  const choice = await vscode.window.showInformationMessage(
    `agentia was installed to ${bin} because the system npm folder is not writable. Add it to PATH in ${path.basename(rc)} so it works in any terminal?`,
    'Add to PATH',
  );
  if (choice !== 'Add to PATH') return;
  const line = `export PATH="${bin}:$PATH"`;
  const existing = fs.existsSync(rc) ? fs.readFileSync(rc, 'utf8') : '';
  if (!existing.includes(line)) fs.appendFileSync(rc, `\n# added by Copado Commit Validator\n${line}\n`);
  void vscode.window.showInformationMessage(`Added to ${rc}. Open a new terminal to use agentia.`);
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
      if (!(await sh('git --version')).ok) return fail('git was not found on your PATH.');
      if (!(await sh('npm --version')).ok) return fail('npm (Node.js) was not found on your PATH.');
      let agentia = await resolveAgentia();
      if (!agentia) {
        const choice = await vscode.window.showInformationMessage('The agentia CLI was not found. Install it now?', 'Install agentia CLI');
        if (choice !== 'Install agentia CLI') return;
        step('Installing the agentia CLI...');
        if (!(await installAgentiaCli())) {
          return fail(`Installing the agentia CLI failed. Try "${AGENTIA_CLI_INSTALL}" yourself; see the output for details.`);
        }
        agentia = await resolveAgentia();
        if (!agentia) return fail('The agentia CLI was installed but could not be started. See the output for details.');
        if (agentia !== 'agentia') void offerPathSetup();
      }

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
      if (!(await sh(`${agentia} plugins link "${pluginDir}"`)).ok) return fail('agentia could not link the plugin. See the output for details.');

      const listed = await sh(`${agentia} plugins`);
      if (!listed.stdout.includes(PLUGIN_NAME)) return fail('The plugin was linked but is not listed by agentia. See the output for details.');

      void vscode.window.showInformationMessage(
        'agentia commands installed. Try: agentia verify -s <story>   (also: deploy-plan, deploy)',
      );
    },
  );
}
