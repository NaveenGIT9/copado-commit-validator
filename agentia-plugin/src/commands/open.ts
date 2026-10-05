import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Args, Command } from '@oclif/core';

// The extension watches this file (see vscode-extension/extension.ts) and opens the dashboard
// in the focused VS Code window when it changes.
const TRIGGER_DIR = join(homedir(), '.copado-ccv');
const TRIGGER_FILE = join(TRIGGER_DIR, 'open.trigger');
const FOCUS_SETTLE_MS = 1500;

export default class Open extends Command {
  static summary = 'Open the Copado Commit Validator dashboard in VS Code';
  static description =
    'Brings VS Code to the front and opens the Copado Commit Validator dashboard in it. Requires the extension (v2.0 or newer, with open-trigger support) to be installed.';
  static examples = ['<%= config.bin %> open CCV'];
  static args = {
    target: Args.string({ required: true, description: 'What to open. Currently only: CCV', options: ['CCV', 'ccv'] }),
  };

  async run(): Promise<void> {
    await this.parse(Open);

    // Focus the last active VS Code window first: only the focused window reacts to the trigger.
    // windowsHide stops a console window from flashing while `code` starts.
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('code', ['--reuse-window'], { shell: true, detached: true, stdio: 'ignore', windowsHide: true });
      proc.on('error', reject);
      proc.on('spawn', () => {
        proc.unref();
        resolve();
      });
    }).catch((err: Error) => {
      this.error(`Could not run "code". Is VS Code's command line tool on your PATH? (${err.message})`);
    });

    await sleep(FOCUS_SETTLE_MS);

    mkdirSync(TRIGGER_DIR, { recursive: true });
    writeFileSync(TRIGGER_FILE, String(Date.now()));

    this.log('Opening Copado Commit Validator in VS Code...');
    this.log('Nothing opened? Make sure the extension was reinstalled and VS Code reloaded, then check Output > Copado Commit Validator.');
  }
}
