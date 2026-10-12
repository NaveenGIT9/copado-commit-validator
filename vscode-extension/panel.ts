import * as vscode from 'vscode';
import { spawn, spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const RUNNER_PATH = path.join(__dirname, '..', 'runner.bundle.js');

// VSCode's process.execPath is the Electron binary, not node — Electron's HTTP stack
// can behave differently (e.g. after a VSCode update). Resolve system node instead.
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

const RUN_TIMEOUT_MS = 1_500_000; // 25 minutes — first-time clone of large repos can take a while
const FETCH_TIMEOUT_MS = 20_000; // 20 seconds — a fetch normally takes about a second; one that takes longer is restarted

// What the extension does is written to an Output panel (View > Output > "Copado Commit Validator"), so a run that goes
// quiet can be traced: the click, the runner start, its first output and how it ended.
let outputChannel: vscode.OutputChannel | undefined;
function logLine(message: string): void {
  try {
    outputChannel ??= vscode.window.createOutputChannel('Copado Commit Validator');
    outputChannel.appendLine(`${new Date().toISOString().slice(11, 23)}  ${message}`);
  } catch { /* logging must never break the dashboard */ }
}
const summarizeArgs = (args: string[]): string => args.slice(1).join(' ').slice(0, 160);

export class PromoterPanel {
  public static currentPanel: PromoterPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  // verify / promote
  private activeProc: ReturnType<typeof spawn> | null = null;
  private activeTimer: ReturnType<typeof setTimeout> | null = null;
  private activeKind: 'verify' | 'promote' | null = null;
  // fetch of ready stories (tracked apart, so it can be replaced without touching a verify or a promotion)
  private fetchProc: ReturnType<typeof spawn> | null = null;
  private fetchTimer: ReturnType<typeof setTimeout> | null = null;
  // The last fetch the user asked for, so a fetch that does not finish can be repeated after the dashboard is restarted.
  private lastFetch: { envType: string; orgAlias: string; filterJson: string; pipelineId: string } | null = null;
  private autoRetryUsed = false; // at most one automatic second try per click
  private pendingAutoFetch: { envType: string; orgAlias: string; filterJson: string; pipelineId: string } | null = null;
  // processes that were stopped on purpose; their exit is not reported to the page
  private readonly silenced = new WeakSet<object>();

  private readonly context: vscode.ExtensionContext;

  public static createOrShow(extensionUri: vscode.Uri, context: vscode.ExtensionContext): void {
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
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'copado-logo.png');
    PromoterPanel.currentPanel = new PromoterPanel(panel, extensionUri, context);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
    this.panel = panel;
    this.context = context;
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

  private saveOrgHistory(alias: string): void {
    if (!alias) return;
    const history: string[] = this.context.globalState.get('promoter.orgHistory', []);
    const deduped = [alias, ...history.filter(h => h !== alias)].slice(0, 5);
    void this.context.globalState.update('promoter.orgHistory', deduped);
  }

  private handleMessage(msg: {
    command: string;
    stories?: string;
    orgAlias?: string;
    repoPath?: string;
    pipelineRepoUri?: string;
    pipelineId?: string;
    auto?: boolean;
    envType?: string;
    filterJson?: string;
    url?: string;
    filters?: unknown;
    groups?: Array<{ projectId: string; credentialId: string; stories: string[]; storyIds: string[] }>;
    mergeDeployAfter?: boolean;
    storyNames?: string[];
    storyIds?: string[];
  }): void {
    logLine(`page asked: ${msg.command}`);
    if (msg.command === 'verify') {
      this.saveOrgHistory(msg.orgAlias ?? '');
      this.runVerify(msg.stories ?? '', msg.orgAlias ?? '', msg.repoPath ?? '', msg.pipelineRepoUri ?? '', msg.pipelineId ?? '');
    } else if (msg.command === 'promote') {
      this.saveOrgHistory(msg.orgAlias ?? '');
      this.runPromote(msg.groups ?? [], msg.orgAlias ?? '', msg.mergeDeployAfter ?? false);
    } else if (msg.command === 'fetchReady') {
      if (!msg.auto) this.autoRetryUsed = false; // a click by the user starts a fresh allowance
      this.saveOrgHistory(msg.orgAlias ?? '');
      this.runFetchReady(msg.envType ?? 'QA', msg.orgAlias ?? '', msg.filterJson ?? '', msg.pipelineId ?? '');
    } else if (msg.command === 'fetchPipelineEnvs') {
      this.saveOrgHistory(msg.orgAlias ?? '');
      this.runFetchPipelineEnvs(msg.orgAlias ?? '');
    } else if (msg.command === 'describeFields') {
      this.runDescribeFields(msg.orgAlias ?? '');
    } else if (msg.command === 'lookupStories') {
      this.runLookupStories(msg.storyNames ?? [], msg.orgAlias ?? '');
    } else if (msg.command === 'pollTests') {
      this.runPollTests(msg.storyIds ?? [], msg.orgAlias ?? '');
    } else if (msg.command === 'saveFilters') {
      void this.context.globalState.update('promoter.fetchFilters', msg.filters);
      const pipelineId: string = msg.pipelineId ?? '';
      if (pipelineId) {
        const byPipeline = this.context.globalState.get<Record<string, unknown>>('promoter.fetchFiltersByPipeline', {});
        byPipeline[pipelineId] = msg.filters;
        void this.context.globalState.update('promoter.fetchFiltersByPipeline', byPipeline);
      }
    } else if (msg.command === 'resetDashboard') {
      this.resetDashboard();
    } else if (msg.command === 'abort') {
      this.abortRun();
    } else if (msg.command === 'getDefaultOrg') {
      this.post({ type: 'default-org', org: this.getDefaultOrg() });
    } else if (msg.command === 'openUrl') {
      void vscode.env.openExternal(vscode.Uri.parse(msg.url ?? ''));
    }
  }

  private runLookupStories(storyNames: string[], orgAlias: string): void {
    if (!orgAlias || storyNames.length === 0) return;
    const args = [
      RUNNER_PATH,
      '--target-org', orgAlias,
      '--lookup-stories', 'true',
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
          if (msg.type === 'story-lookup-result' || msg.type === 'story-lookup-error') this.post(msg);
        } catch { /* ignore non-JSON */ }
      }
    });
    proc.on('close', () => clearTimeout(timer));
  }

  private runPollTests(storyIds: string[], orgAlias: string): void {
    if (!orgAlias || storyIds.length === 0) return;
    const args = [
      RUNNER_PATH,
      '--target-org', orgAlias,
      '--poll-tests', 'true',
      '--story-ids', storyIds.join(','),
    ];
    const proc = spawn(NODE_EXEC_PATH, args, { shell: false, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
    const timer = setTimeout(() => proc.kill(), 20_000);
    let buf = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines.filter(l => l.trim())) {
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          if (msg.type === 'test-status-update' || msg.type === 'test-status-error') this.post(msg);
        } catch { /* ignore non-JSON */ }
      }
    });
    proc.on('close', () => clearTimeout(timer));
  }

  private runDescribeFields(orgAlias: string): void {
    if (!orgAlias) return;
    const args = [RUNNER_PATH, '--target-org', orgAlias, '--describe-object', 'copado__User_Story__c'];
    const proc = spawn(NODE_EXEC_PATH, args, { shell: false });
    const timer = setTimeout(() => proc.kill(), 30_000);
    let buf = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines.filter(l => l.trim())) {
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          if (msg.type === 'fields' || msg.type === 'fields-error') this.post(msg);
        } catch { /* ignore non-JSON */ }
      }
    });
    proc.on('close', () => clearTimeout(timer));
  }

  private runFetchReady(envType: string, orgAlias: string, filterJson: string, pipelineId = ''): void {
    this.lastFetch = { envType, orgAlias, filterJson, pipelineId };
    const args = [
      RUNNER_PATH,
      '--target-org', orgAlias,
      '--fetch-ready', 'true',
      '--env-type', envType,
      '--filters', filterJson,
      ...(pipelineId ? ['--pipeline-id', pipelineId] : []),
    ];
    this.spawnCommand(args, 'fetch');
  }

  private runFetchPipelineEnvs(orgAlias: string): void {
    if (!orgAlias) return;
    const args = [RUNNER_PATH, '--target-org', orgAlias, '--fetch-pipeline-envs', 'true'];
    const proc = spawn(NODE_EXEC_PATH, args, { shell: false });
    const timer = setTimeout(() => proc.kill(), 30_000);
    let buf = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines.filter(l => l.trim())) {
        try {
          const evt = JSON.parse(line) as Record<string, unknown>;
          if (evt.type === 'pipeline-list' || evt.type === 'pipeline-envs-error') this.post(evt);
        } catch { /* ignore non-JSON */ }
      }
    });
    proc.on('close', () => clearTimeout(timer));
  }

  // Reset = what closing and reopening the dashboard does. The page stays alive while it is hidden, so its state (and the
  // extension's record of running work) can go stale; this stops unfinished fetch/verify work and loads the page again from scratch.
  // A running promotion is never cut short, and then the page is left in place so its progress stays on screen.
  private resetDashboard(): boolean {
    logLine('reset: restarting the dashboard');
    this.stopFetch();
    if (this.activeProc && this.activeKind === 'promote') {
      logLine('reset: a promotion is running, so the page is not reloaded');
      return false;
    }
    if (this.activeProc) {
      if (this.activeTimer) { clearTimeout(this.activeTimer); this.activeTimer = null; }
      this.silenced.add(this.activeProc);
      this.activeProc.kill();
      this.activeProc = null;
      this.activeKind = null;
    }
    // VS Code ignores a new html value that equals the old one, so a changing comment forces a real reload.
    this.panel.webview.html = `${this.getHtml()}\n<!-- reload ${Date.now()} -->`;
    return true;
  }

  // A fetch that did not finish in time: restart the dashboard (as Reset does) and have the page ask for the same fetch again.
  // Only once per click: if the second try also stalls, the user is told instead of looping. Returns false when it cannot recover.
  private recoverFetch(): boolean {
    if (!this.lastFetch || this.autoRetryUsed) return false;
    logLine(`fetch of ${this.lastFetch.envType} did not finish in ${FETCH_TIMEOUT_MS / 1000} s: restarting the dashboard and fetching again`);
    this.autoRetryUsed = true;
    this.pendingAutoFetch = this.lastFetch;
    if (this.resetDashboard()) return true;
    this.pendingAutoFetch = null; // a promotion is running, so the page cannot be reloaded
    return false;
  }

  private abortRun(): void {
    logLine('cancel requested');
    this.stopFetch();
    if (this.activeTimer) { clearTimeout(this.activeTimer); this.activeTimer = null; }
    if (this.activeProc) { this.silenced.add(this.activeProc); this.activeProc.kill(); this.activeProc = null; this.activeKind = null; }
    this.post({ type: 'aborted' });
  }

  private runVerify(stories: string, orgAlias: string, repoPath: string, pipelineRepoUri = '', pipelineId = ''): void {
    const storyList = stories.split(/[\n,]+/).map(s => s.trim()).filter(Boolean).join(',');
    this.post({ type: 'run-start' });

    const args = [
      RUNNER_PATH,
      '--stories', storyList,
      '--target-org', orgAlias,
      ...(repoPath ? ['--repo-path', repoPath] : []),
      ...(pipelineRepoUri ? ['--pipeline-repo-uri', pipelineRepoUri] : []),
      ...(pipelineId ? ['--pipeline-id', pipelineId] : []),
    ];
    this.spawnCommand(args, 'verify');
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
    this.spawnCommand(args, 'promote');
  }

  // Starts the runner. Every run owns its process and timer, so one run can never clear another's. A fetch (read-only, a few
  // seconds) is tracked apart from verify and promote: starting a new fetch stops an unfinished earlier one, but a fetch can
  // never cut a verify or a promotion short.
  private spawnCommand(args: string[], kind: 'fetch' | 'verify' | 'promote'): void {
    const isFetch = kind === 'fetch';
    if (isFetch) this.stopFetch();

    const proc = spawn(NODE_EXEC_PATH, args, { shell: false, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
    let sawResult = false; // for a fetch: the runner reported its outcome (fetch-done, or fatal with the reason)
    const startedAt = Date.now();
    let gotOutput = false;
    logLine(`start ${kind}: pid ${proc.pid}, node ${NODE_EXEC_PATH}, ${summarizeArgs(args)}`);
    // Tell the page right away that the runner started, so it can tell "started but quiet" from "never started".
    if (isFetch) this.post({ type: 'fetch-started', pid: proc.pid });

    const timer = setTimeout(() => {
      logLine(`${kind} pid ${proc.pid}: no result within the time limit, stopping it`);
      this.silenced.add(proc);
      proc.kill();
      this.release(proc, isFetch);
      if (isFetch && this.recoverFetch()) return;
      this.post({
        type: 'fatal',
        message: isFetch
          ? 'The fetch did not finish within 20 seconds, even after restarting the dashboard. Check your network and the Copado org, then click the environment again. (View > Output > "Copado Commit Validator" shows what happened.)'
          : 'Timed out after 25 minutes. Check org connectivity and try again.',
      });
    }, isFetch ? FETCH_TIMEOUT_MS : RUN_TIMEOUT_MS);

    if (isFetch) {
      this.fetchProc = proc;
      this.fetchTimer = timer;
    } else {
      this.activeProc = proc;
      this.activeTimer = timer;
      this.activeKind = kind === 'promote' ? 'promote' : 'verify';
    }

    const handleLine = (line: string): void => {
      if (!gotOutput) {
        gotOutput = true;
        logLine(`${kind} pid ${proc.pid}: first output after ${Date.now() - startedAt} ms`);
      }
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (isFetch && (msg.type === 'fetch-done' || msg.type === 'fatal')) sawResult = true;
        if (isFetch && msg.type === 'fetch-done') this.autoRetryUsed = false;
        // For fetch-done and stories-fetched: try to resolve repoName to a local
        // workspace folder path (best-effort; blank if not open in this window).
        if ((isFetch && msg.type === 'fetch-done' && msg.repoName) ||
            (msg.type === 'stories-fetched' && msg.repoName)) {
          const folders = vscode.workspace.workspaceFolders ?? [];
          const repoName = msg.repoName as string;
          const match = folders.find(f =>
            f.uri.fsPath.endsWith(repoName) ||
            f.uri.fsPath.endsWith('\\' + repoName) ||
            f.uri.fsPath.endsWith('/' + repoName));
          const repoPath = match?.uri.fsPath ?? '';
          this.post({ ...msg, repoPath });
        } else {
          // All other messages (including effective-repo-path) pass through as-is
          this.post(msg);
        }
      } catch {
        this.post({ type: 'stderr', message: `stdout: ${line}` });
      }
    };

    // Output arrives in chunks that need not end on a line break: a long line (for example the list of fetched stories) can
    // be cut in two. Keep the unfinished tail until the rest arrives, otherwise that line is lost and the page never learns
    // the result.
    let buf = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) handleLine(line);
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      this.post({ type: 'stderr', message: text });
    });

    // The runner could not be started at all (for example node was not found). Without this the failure is silent.
    proc.on('error', (err) => {
      clearTimeout(timer);
      logLine(`${kind} pid ${proc.pid}: could not run: ${err.message}`);
      this.release(proc, isFetch);
      if (this.silenced.has(proc)) return;
      this.silenced.add(proc); // a 'close' may follow; the failure is reported here, once
      this.post({ type: 'fatal', message: `The runner could not be started: ${err.message}. Check that Node.js is installed and on your PATH, then reload the window.` });
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      logLine(`${kind} pid ${proc.pid}: ended with code ${code} after ${Date.now() - startedAt} ms${isFetch ? (sawResult ? ', result reported' : ', NO result reported') : ''}${this.silenced.has(proc) ? ' (stopped on purpose)' : ''}`);
      if (buf.trim()) handleLine(buf); // the last line may have no line break after it
      buf = '';
      this.release(proc, isFetch);
      if (this.silenced.has(proc)) return; // stopped on purpose; the page was already told (or no longer waits)
      if (isFetch && !sawResult) {
        // The runner ended without saying what happened. Tell the page, or it would show "Fetching..." forever.
        this.post({
          type: 'fatal',
          message: `The fetch ended without returning stories (exit code ${code}). Open "Show debug log" for details, then try again.`,
        });
        return;
      }
      this.post({ type: 'process-exit', code });
    });
  }

  // Forget a finished or stopped process, but only if it is still the one on record (a newer run may have replaced it).
  private release(proc: ReturnType<typeof spawn>, isFetch: boolean): void {
    if (isFetch) {
      if (this.fetchProc === proc) { this.fetchProc = null; this.fetchTimer = null; }
    } else if (this.activeProc === proc) {
      this.activeProc = null;
      this.activeTimer = null;
      this.activeKind = null;
    }
  }

  private stopFetch(): void {
    if (this.fetchTimer) { clearTimeout(this.fetchTimer); this.fetchTimer = null; }
    if (this.fetchProc) {
      logLine(`stopping the running fetch (pid ${this.fetchProc.pid})`);
      this.silenced.add(this.fetchProc);
      this.fetchProc.kill();
      this.fetchProc = null;
    }
  }

  private post(data: Record<string, unknown>): void {
    void this.panel.webview.postMessage(data);
  }

  private getHtml(): string {
    const htmlPath = path.join(__dirname, '..', 'webview', 'index.html');
    if (fs.existsSync(htmlPath)) {
      let html = fs.readFileSync(htmlPath, 'utf8');
      const defaultOrg = this.getDefaultOrg();
      const orgHistory: string[] = this.context.globalState.get('promoter.orgHistory', []);
      const savedFilters = this.context.globalState.get('promoter.fetchFilters', null);
      const savedFiltersByPipeline = this.context.globalState.get('promoter.fetchFiltersByPipeline', {});
      html = html.replace(
        '<script>',
        `<script>window.__defaultOrg = ${JSON.stringify(defaultOrg)};\nwindow.__orgHistory = ${JSON.stringify(orgHistory)};\nwindow.__savedFilters = ${JSON.stringify(savedFilters)};\nwindow.__savedFiltersByPipeline = ${JSON.stringify(savedFiltersByPipeline)};\nwindow.__autoFetch = ${JSON.stringify(this.pendingAutoFetch)};\n`,
      );
      this.pendingAutoFetch = null; // handed over once
      return html;
    }
    return '<html><body>Loading...</body></html>';
  }

  public dispose(): void {
    // Stop work nobody is waiting for any more. A promotion is left to finish: cutting it short could leave a
    // half-created promotion in Copado.
    this.stopFetch();
    if (this.activeProc && this.activeKind === 'verify') {
      if (this.activeTimer) { clearTimeout(this.activeTimer); this.activeTimer = null; }
      this.silenced.add(this.activeProc);
      this.activeProc.kill();
      this.activeProc = null;
      this.activeKind = null;
    }
    PromoterPanel.currentPanel = undefined;
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
