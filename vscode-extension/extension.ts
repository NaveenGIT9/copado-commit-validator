import * as vscode from 'vscode';
import { PromoterPanel } from './panel';
import { LinkStoriesPanel } from './linkStoriesPanel';

export function activate(context: vscode.ExtensionContext): void {
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
}

export function deactivate(): void {}
