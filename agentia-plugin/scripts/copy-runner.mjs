import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, '..', 'vscode-extension', 'runner.bundle.js');
const dest = join(root, 'bin', 'runner.bundle.cjs');

if (!existsSync(src)) {
  console.error(`Missing ${src}. Run "npm run build" in ../vscode-extension first.`);
  process.exit(1);
}
mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
console.log('copied runner bundle ->', dest);
