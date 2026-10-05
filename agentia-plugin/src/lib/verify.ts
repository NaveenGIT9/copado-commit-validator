import { evaluateStory, type Evaluation } from './eligibility.js';
import { runRunner, type RunnerEvent, type RunOptions } from './runner.js';

export interface VerifyOutcome {
  verified: RunnerEvent[];
  evaluations: Evaluation[];
  storyErrors: Array<{ storyName: string; message: string }>;
  notReturned: string[];
  fatal: string | null;
}

export function parseStoryList(values: string[]): string[] {
  const names = values.flatMap((v) => v.split(/[\s,]+/)).map((s) => s.trim()).filter(Boolean);
  return [...new Set(names)];
}

function progress(message: string): void {
  process.stderr.write(`  ${message}\n`);
}

export async function verifyStories(
  stories: string[],
  org: string,
  onStory?: (ev: RunnerEvent, evaluation: Evaluation) => void,
  options: RunOptions & { repoPath?: string } = {},
): Promise<VerifyOutcome> {
  const verified: RunnerEvent[] = [];
  const evaluations: Evaluation[] = [];
  const storyErrors: Array<{ storyName: string; message: string }> = [];
  let fatal: string | null = null;
  let lastPercent = -1;

  await runRunner(['--stories', stories.join(','), '--target-org', org, ...(options.repoPath ? ['--repo-path', options.repoPath] : [])], (ev) => {
    switch (ev.type) {
      case 'git-clone-start':
        progress(`Cloning ${ev.repoName ?? 'repository'} (first run only)...`);
        break;
      case 'git-clone-progress':
        if (typeof ev.percent === 'number' && ev.percent - lastPercent >= 25) {
          lastPercent = ev.percent;
          progress(`Clone ${ev.percent}%`);
        }
        break;
      case 'git-fetch-start':
        progress('Fetching latest branches...');
        break;
      case 'story-verifying':
        progress(`Verifying ${ev.storyName} (${ev.branch})`);
        break;
      case 'story-error':
        storyErrors.push({ storyName: ev.storyName, message: ev.message });
        break;
      case 'fatal':
        fatal = String(ev.message);
        break;
      case 'story-verified': {
        const evaluation = evaluateStory(ev);
        verified.push(ev);
        evaluations.push(evaluation);
        onStory?.(ev, evaluation);
        break;
      }
      default:
        break;
    }
  }, options);

  const seen = new Set([...verified.map((v) => v.storyName), ...storyErrors.map((e) => e.storyName)].map((s) => s.toUpperCase()));
  const notReturned = fatal ? [] : stories.filter((s) => !seen.has(s.toUpperCase()));
  return { verified, evaluations, storyErrors, notReturned, fatal };
}
