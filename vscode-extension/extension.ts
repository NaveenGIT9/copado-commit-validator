import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { PromoterPanel } from './panel';
import { LinkStoriesPanel } from './linkStoriesPanel';
import { installAgentiaCommands } from './installAgentia';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('promoter.installAgentia', () => installAgentiaCommands()),
  );

  const cmd = vscode.commands.registerCommand('promoter.open', () => {
    PromoterPanel.createOrShow(context.extensionUri, context);
  });
  context.subscriptions.push(cmd);

  const linkStoriesCmd = vscode.commands.registerCommand('promoter.openLinkStories', () => {
    LinkStoriesPanel.createOrShow(context.extensionUri);
  });
  context.subscriptions.push(linkStoriesCmd);

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.text = '$(git-merge) Link Stories';
  statusBarItem.tooltip = 'Add existing User Stories to a Copado Promotion';
  statusBarItem.command = 'promoter.openLinkStories';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Lets the agentia CLI open the dashboard: `agentia open CCV` -> vscode://<publisher>.promoter/open
  const output = vscode.window.createOutputChannel('Copado Commit Validator');
  context.subscriptions.push(
    output,
    vscode.window.registerUriHandler({
      handleUri(uri: vscode.Uri): void {
        output.appendLine(`${new Date().toISOString()}  URI received: ${uri.toString()}`);
        if (uri.path === '/open') {
          void vscode.commands.executeCommand('promoter.open');
          void vscode.window.showInformationMessage('Copado Commit Validator opened from the agentia CLI.');
        } else {
          void vscode.window.showWarningMessage(`Copado Commit Validator: unknown link "${uri.path}".`);
        }
      },
    }),
  );

  // Trigger file used by `agentia open CCV`: the CLI touches ~/.copado-ccv/open.trigger and the
  // focused VS Code window opens the dashboard. Only the focused window reacts so that several
  // open windows don't each open a tab.
  const triggerDir = path.join(os.homedir(), '.copado-ccv');
  const triggerName = 'open.trigger';
  const triggerFile = path.join(triggerDir, triggerName);
  const STARTUP_GRACE_MS = 20_000;
  let lastOpen = 0;

  const openFromTrigger = (reason: string): void => {
    const now = Date.now();
    if (now - lastOpen < 1500) return;
    lastOpen = now;
    output.appendLine(`${new Date().toISOString()}  open trigger (${reason}) - opening dashboard`);
    void vscode.commands.executeCommand('promoter.open');
  };

  try {
    fs.mkdirSync(triggerDir, { recursive: true });
    const watcher = fs.watch(triggerDir, (_event, filename) => {
      if (filename !== triggerName) return;
      if (!vscode.window.state.focused) return;
      openFromTrigger('file changed');
    });
    context.subscriptions.push({ dispose: () => watcher.close() });

    // VS Code may have been started by the CLI itself: honour a trigger written just before we activated.
    if (fs.existsSync(triggerFile) && Date.now() - fs.statSync(triggerFile).mtimeMs < STARTUP_GRACE_MS && vscode.window.state.focused) {
      openFromTrigger('recent trigger at startup');
    }
  } catch (err) {
    output.appendLine(`Could not watch ${triggerDir}: ${String(err)}`);
  }
}

export function deactivate(): void {}
