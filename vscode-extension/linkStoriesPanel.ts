import * as vscode from 'vscode';
import { spawn, spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const RUNNER_PATH = path.join(__dirname, '..', 'runner.bundle.js');

// VSCode's process.execPath is the Electron binary, not node — resolve system node instead.
const NODE_EXEC_PATH = (() => {
  try {
    const r = spawnSync(
      process.platform === 'win32' ? 'where' : 'which',
      ['node'],
      { encoding: 'utf8', shell: false, timeout: 5000 }
    );
    const first = (r.stdout ?? '').split(/\r?\n/)[0].trim();
    if (first) return first;
  } catch { /* fall through */ }
  return process.execPath;
})();

// Standalone utility — adds existing User Stories onto an existing Promotion (by
// human-readable Number, not Id). Intentionally has no dependency on PromoterPanel/
// the verify-and-promote flow; it's a separate module launched from its own status
// bar button.
export class LinkStoriesPanel {
  public static currentPanel: LinkStoriesPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionUri: vscode.Uri): void {
    if (LinkStoriesPanel.currentPanel) {
      LinkStoriesPanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'copadoLinkStories',
      'Link Stories to Promotion',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'copado-logo.png');
    LinkStoriesPanel.currentPanel = new LinkStoriesPanel(panel);
  }

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.panel.webview.html = this.getHtml();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((msg) => this.handleMessage(msg), null, this.disposables);
  }

  private getDefaultOrg(): string {
    // Check config files first (instant). SF stores target-org locally per-project in .sf/config.json.
    const workspacePaths = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    const candidates = [
      ...workspacePaths.map(p => path.join(p, '.sf', 'config.json')),
      path.join(process.cwd(), '.sf', 'config.json'),
      path.join(os.homedir(), '.sf', 'config.json'),
      path.join(os.homedir(), '.sfdx', 'sfdx-config.json'),
    ];
    for (const p of candidates) {
      try {
        if (!fs.existsSync(p)) continue;
        const cfg = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, string>;
        const val = cfg['target-org'] ?? cfg['defaultusername'] ?? '';
        if (val) return val;
      } catch { /* try next candidate */ }
    }

    // Last resort: ask sf CLI directly. shell:true resolves sf.cmd on Windows.
    // SF CLI loads all plugins on startup (~15 s) — give it 20 s.
    try {
      const result = spawnSync('sf', ['config', 'get', 'target-org', '--json'], {
        timeout: 20_000,
        encoding: 'utf8',
        shell: true,
      });
      const parsed = JSON.parse(result.stdout ?? '') as { result?: Array<{ value?: string }> };
      const val = parsed?.result?.[0]?.value ?? '';
      if (val) return val;
    } catch { /* give up */ }

    return '';
  }

  private handleMessage(msg: { command: string; promotionName?: string; storyNames?: string[]; orgAlias?: string }): void {
    if (msg.command === 'linkStories') {
      this.runLinkStories(msg.promotionName ?? '', msg.storyNames ?? [], msg.orgAlias ?? '');
    }
  }

  private runLinkStories(promotionName: string, storyNames: string[], orgAlias: string): void {
    if (!orgAlias || !promotionName || storyNames.length === 0) return;
    const args = [
      RUNNER_PATH,
      '--target-org', orgAlias,
      '--link-stories', 'true',
      '--promotion-name', promotionName,
      '--stories', storyNames.join(','),
    ];
    const proc = spawn(NODE_EXEC_PATH, args, { shell: false, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
    const timer = setTimeout(() => proc.kill(), 30_000);
    let buf = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines.filter(l => l.trim())) {
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          if (msg.type === 'link-story-result' || msg.type === 'link-stories-done') this.post(msg);
          // Remap the runner's generic auth-failure 'fatal' onto our own error type
          // so the webview only ever needs to handle one error message shape.
          else if (msg.type === 'link-stories-error' || msg.type === 'fatal') this.post({ ...msg, type: 'link-stories-error' });
        } catch { /* ignore non-JSON */ }
      }
    });
    proc.on('close', () => clearTimeout(timer));
  }

  private post(data: Record<string, unknown>): void {
    void this.panel.webview.postMessage(data);
  }

  private getHtml(): string {
    const htmlPath = path.join(__dirname, '..', 'webview', 'linkStories.html');
    if (fs.existsSync(htmlPath)) {
      let html = fs.readFileSync(htmlPath, 'utf8');
      html = html.replace('<script>', `<script>window.__defaultOrg = ${JSON.stringify(this.getDefaultOrg())};\n`);
      return html;
    }
    return '<html><body>Loading...</body></html>';
  }

  public dispose(): void {
    LinkStoriesPanel.currentPanel = undefined;
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
