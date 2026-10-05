import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RunnerEvent = { type: string; [key: string]: any };

const here = dirname(fileURLToPath(import.meta.url));
export const RUNNER_PATH = join(here, '..', '..', 'bin', 'runner.bundle.cjs');

const RUN_TIMEOUT_MS = 1_500_000;

export function resolveOrg(flagValue?: string): string {
  if (flagValue) return flagValue;

  const candidates = [
    join(process.cwd(), '.sf', 'config.json'),
    join(homedir(), '.sf', 'config.json'),
    join(homedir(), '.sfdx', 'sfdx-config.json'),
  ];
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      const cfg = JSON.parse(readFileSync(p, 'utf8')) as Record<string, string>;
      const val = cfg['target-org'] ?? cfg['defaultusername'] ?? '';
      if (val) return val;
    } catch {
      /* try next candidate */
    }
  }

  try {
    const r = spawnSync('sf', ['config', 'get', 'target-org', '--json'], {
      timeout: 20_000,
      encoding: 'utf8',
      shell: true,
    });
    const parsed = JSON.parse(r.stdout ?? '') as { result?: Array<{ value?: string }> };
    const val = parsed?.result?.[0]?.value ?? '';
    if (val) return val;
  } catch {
    /* give up */
  }

  throw new Error('No target org found. Pass --target-org <alias> or set one with "sf config set target-org <alias>".');
}

export interface RunResult {
  code: number | null;
  events: RunnerEvent[];
}

export interface RunOptions {
  gitUser?: string;
}

export function runRunner(args: string[], onEvent: (event: RunnerEvent) => void, options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (!existsSync(RUNNER_PATH)) {
      reject(new Error(`Runner bundle not found at ${RUNNER_PATH}. Run "npm run build" in the plugin folder.`));
      return;
    }

    const proc = spawn(process.execPath, [RUNNER_PATH, ...args], {
      shell: false,
      env: {
        ...process.env,
        NODE_NO_WARNINGS: '1',
        // Tells Git Credential Manager which GitHub account to use for the pipeline repo.
        ...(options.gitUser
          ? {
              GIT_CONFIG_COUNT: '1',
              GIT_CONFIG_KEY_0: 'credential.https://github.com.username',
              GIT_CONFIG_VALUE_0: options.gitUser,
            }
          : {}),
      },
    });

    const events: RunnerEvent[] = [];
    let buf = '';
    let stderr = '';

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('Timed out after 25 minutes.'));
    }, RUN_TIMEOUT_MS);

    const handleLine = (line: string): void => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line) as RunnerEvent;
        events.push(event);
        onEvent(event);
      } catch {
        /* ignore non-JSON output */
      }
    };

    proc.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      lines.forEach(handleLine);
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      handleLine(buf);
      if (events.length === 0 && stderr.trim()) {
        reject(new Error(stderr.trim().split('\n').slice(-3).join('\n')));
        return;
      }
      resolve({ code, events });
    });
  });
}
