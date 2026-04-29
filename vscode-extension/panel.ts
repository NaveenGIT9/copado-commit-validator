import * as vscode from 'vscode';
import { spawn, spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const RUNNER_PATH = path.join('D:', 'plugin-promoter', 'runner.mjs');

interface StoryResult {
  storyName: string;
  storyId: string;
  branch: string;
  extraCommits: string[];
  copadoCommits: string[];
  unregistered: string[];
  verdict: 'clean' | 'skip-no-commits' | 'skip-unregistered' | 'error';
  message?: string;
}

const RUN_TIMEOUT_MS = 120_000; // 2 minutes

export class PromoterPanel {
  public static currentPanel: PromoterPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private activeProc: ReturnType<typeof spawn> | null = null;
  private activeTimer: ReturnType<typeof setTimeout> | null = null;

  public static createOrShow(extensionUri: vscode.Uri): void {
    if (PromoterPanel.currentPanel) {
      PromoterPanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'sfPromoter',
      'Copado Commit Validator',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    PromoterPanel.currentPanel = new PromoterPanel(panel, extensionUri);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.panel.webview.html = this.getHtml();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((msg) => this.handleMessage(msg), null, this.disposables);
    this.postDefaults();
  }

  private postDefaults(): void {
    // no-op — default org is now injected directly into HTML at load time via getDefaultOrg()
  }

  private getDefaultOrg(): string {
    // Check config files first (instant). SF stores target-org locally per-project in .sf/config.json.
    // Check all VS Code workspace folders so we find whichever project is open.
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
      } catch { /* try next */ }
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

  private handleMessage(msg: {
    command: string;
    stories?: string;
    orgAlias?: string;
    repoPath?: string;
    envType?: string;
    groups?: Array<{ projectId: string; credentialId: string; stories: string[]; storyIds: string[] }>;
    mergeDeployAfter?: boolean;
  }): void {
    if (msg.command === 'verify') {
      this.runVerify(msg.stories ?? '', msg.orgAlias ?? '', msg.repoPath ?? '');
    } else if (msg.command === 'promote') {
      this.runPromote(msg.groups ?? [], msg.orgAlias ?? '', msg.mergeDeployAfter ?? false);
    } else if (msg.command === 'fetchReady') {
      this.runFetchReady(msg.envType ?? 'QA', msg.orgAlias ?? '');
    } else if (msg.command === 'abort') {
      this.abortRun();
    }
  }

  private runFetchReady(envType: string, orgAlias: string): void {
    const args = [
      RUNNER_PATH,
      '--target-org', orgAlias,
      '--fetch-ready', 'true',
      '--env-type', envType,
    ];
    this.spawnCommand(args, true);
  }

  private abortRun(): void {
    if (this.activeTimer) { clearTimeout(this.activeTimer); this.activeTimer = null; }
    if (this.activeProc) { this.activeProc.kill(); this.activeProc = null; }
    this.post({ type: 'aborted' });
  }

  private runVerify(stories: string, orgAlias: string, repoPath: string): void {
    const storyList = stories.split(/[\n,]+/).map(s => s.trim()).filter(Boolean).join(',');
    this.post({ type: 'run-start' });

    const args = [
      RUNNER_PATH,
      '--stories', storyList,
      '--target-org', orgAlias,
      '--repo-path', repoPath || process.cwd(),
    ];
    this.spawnCommand(args);
  }

  private runPromote(
    groups: Array<{ projectId: string; credentialId: string; stories: string[]; storyIds: string[] }>,
    orgAlias: string,
    mergeDeployAfter: boolean
  ): void {
    if (groups.length === 0) {
      this.post({ type: 'promote-none' });
      return;
    }
    const totalStories = groups.reduce((n, g) => n + g.stories.length, 0);
    this.post({ type: 'promote-start-ui', count: totalStories });

    const args = [
      RUNNER_PATH,
      '--target-org', orgAlias,
      '--promote', 'true',
      '--groups', JSON.stringify(groups),
      '--merge-deploy', String(mergeDeployAfter),
    ];
    this.spawnCommand(args);
  }

  private spawnCommand(args: string[], isFetch = false): void {
    const proc = spawn(process.execPath, args, { shell: false });
    this.activeProc = proc;

    this.activeTimer = setTimeout(() => {
      proc.kill();
      this.activeProc = null;
      this.activeTimer = null;
      this.post({ type: 'fatal', message: 'Timed out after 2 minutes. Check org connectivity and try again.' });
    }, RUN_TIMEOUT_MS);

    proc.stdout.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          if ((isFetch && msg.type === 'fetch-done' && msg.repoName) ||
              (msg.type === 'repo-name' && msg.repoName)) {
            const folders = vscode.workspace.workspaceFolders ?? [];
            const repoName = msg.repoName as string;
            const match = folders.find(f =>
              f.uri.fsPath.endsWith(repoName) ||
              f.uri.fsPath.endsWith('\\' + repoName) ||
              f.uri.fsPath.endsWith('/' + repoName));
            const repoPath = match?.uri.fsPath ?? '';
            this.post({ ...msg, repoPath });
          } else {
            this.post(msg);
          }
        } catch {
          this.post({ type: 'stderr', message: `stdout: ${line}` });
        }
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      this.post({ type: 'stderr', message: text });
    });

    proc.on('close', (code) => {
      if (this.activeTimer) { clearTimeout(this.activeTimer); this.activeTimer = null; }
      this.activeProc = null;
      this.post({ type: 'process-exit', code });
    });
  }

  private post(data: Record<string, unknown>): void {
    void this.panel.webview.postMessage(data);
  }

  private getHtml(): string {
    const htmlPath = path.join(__dirname, '..', 'webview', 'index.html');
    if (fs.existsSync(htmlPath)) {
      let html = fs.readFileSync(htmlPath, 'utf8');
      const defaultOrg = this.getDefaultOrg();
      const defaultRepoPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
      html = html.replace(
        '<script>',
        `<script>window.__defaultOrg = ${JSON.stringify(defaultOrg)};\nwindow.__defaultRepoPath = ${JSON.stringify(defaultRepoPath)};\n`,
      );
      return html;
    }
    return '<html><body>Loading...</body></html>';
  }

  public dispose(): void {
    PromoterPanel.currentPanel = undefined;
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
