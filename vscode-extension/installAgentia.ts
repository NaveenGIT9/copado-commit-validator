import { execFile } from 'child_process';
import * as vscode from 'vscode';

// Plugin that adds `agentia verify`, `agentia deploy-plan` and `agentia deploy`.
const PLUGIN_NAME = '@naveengit9/agentia-ccv';
const PLUGIN_URL = 'https://github.com/NaveenGIT9/agentia-ccv';
const AGENTIA_CLI_INSTALL = 'npm install -g @copado/agentia-cli';

function run(command: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    // shell: true so agentia.cmd resolves on Windows.
    execFile(command, args, { shell: true, timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      resolve({ ok: !error, stdout: String(stdout ?? '') });
    });
  });
}

function runInTerminal(commandLine: string): void {
  const terminal = vscode.window.createTerminal('agentia commands');
  terminal.show();
  terminal.sendText(commandLine);
}

export async function installAgentiaCommands(): Promise<void> {
  const version = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Checking for the agentia CLI...' },
    () => run('agentia', ['--version'], 30_000),
  );

  if (!version.ok) {
    const choice = await vscode.window.showErrorMessage(
      `The agentia CLI was not found. Install it first (${AGENTIA_CLI_INSTALL}), then run this command again.`,
      'Install agentia CLI',
    );
    if (choice === 'Install agentia CLI') runInTerminal(AGENTIA_CLI_INSTALL);
    return;
  }

  const plugins = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Checking installed agentia plugins...' },
    () => run('agentia', ['plugins'], 30_000),
  );

  if (plugins.ok && plugins.stdout.includes(PLUGIN_NAME)) {
    const choice = await vscode.window.showInformationMessage(
      'The agentia commands (verify, deploy-plan, deploy) are already installed. Reinstall to update them?',
      'Reinstall',
    );
    if (choice !== 'Reinstall') return;
  }

  runInTerminal(`agentia plugins install ${PLUGIN_URL}`);
  void vscode.window.showInformationMessage(
    'Installing the agentia commands in the terminal. When it finishes, try: agentia verify -s <story>',
  );
}
