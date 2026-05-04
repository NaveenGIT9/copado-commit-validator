import * as vscode from 'vscode';
import { PromoterPanel } from './panel';

export function activate(context: vscode.ExtensionContext): void {
  const cmd = vscode.commands.registerCommand('promoter.open', () => {
    PromoterPanel.createOrShow(context.extensionUri, context);
  });
  context.subscriptions.push(cmd);
}

export function deactivate(): void {}
