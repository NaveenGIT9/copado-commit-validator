# agentia-ccv

Copado Commit Validator for the [agentia](https://www.npmjs.com/package/@copado/agentia-cli) CLI. Verify and promote Copado User Stories from the terminal, using the same logic as the Copado Commit Validator VS Code extension.

```
agentia open CCV                        # open the dashboard in VS Code
agentia verify -s US-0031309,US-0031310 # verify stories, print the details
agentia deploy-plan -s US-0031309,US-0028426   # show how promotions would be created (changes nothing)
agentia deploy -s US-0031309            # promote promotable stories with Merge & Deploy
```

## Commands

### `agentia verify -s <stories>`
Checks each story branch against Copado: unregistered commits, metadata coverage, tests, PR approval, parent/dependency stories and existing promotions. Exit code is `1` if any story is not promotable.

### `agentia deploy-plan -s <stories>`
Verifies the stories and prints the **promotion plan** as a table: which stories go into which promotion, grouped by project (default) or by source environment (`--group-by env`), with each story's source environment and the destination. It never creates or changes anything in Copado, and ends with the exact `agentia deploy` command to run for that plan.

### `agentia deploy -s <stories>`
Verifies, then builds promotions the way the panel's **Promote** button does and triggers Merge & Deploy.
- Stories already in a **Conflicts Resolved** promotion re-trigger that promotion (a **Validated** one is deploy-only).
- Shows the promotion plan and asks for confirmation. `--yes` skips the prompt. Without a terminal and without `--yes` it refuses to run. Stories that are not promotable (blocked, not found, promotion in progress) are left out and reported; the exit code is 1 if any were left out.
- Merge & Deploy is *queued* in Copado. The command does not wait for the deployment job to finish.

### `agentia open CCV`
Opens the dashboard through the extension's URI handler (needs the extension installed, v2.0+ with URI support, and `code` on your PATH).

### Flags (verify, deploy-plan and deploy)
| Flag | Purpose |
|---|---|
| `-s, --stories` | Story names, comma-separated or repeat the flag |
| `-o, --target-org` | Copado org alias (default: `sf` target-org) |
| `--git-user` / `CCV_GIT_USER` | GitHub account git should use for the pipeline repo, when your default git account has no access to it |
| `--repo-path` | Use an existing local clone instead of the temp clone |
| `--group-by project|env` | (deploy-plan, deploy) one promotion per project + credential (default), or per source environment |
| `--details` | Print the full per-story card after the table |

The pipeline, repo and destination are resolved from the story itself, exactly as in the extension. The first run clones the pipeline repo into a temp folder.

## Install (local link)

```
cd agentia-plugin
npm install
npm run build        # compiles the plugin and copies ../vscode-extension/runner.bundle.js into bin/
agentia plugins link .
```

`npm run build` in `vscode-extension` must have been run first (it produces `runner.bundle.js`).
The "linked ESM module cannot be auto-transpiled" warning from agentia is harmless: the compiled `dist/` is used.

Remove with `agentia plugins uninstall @naveengit9/agentia-ccv`.

## Notes
- Eligibility, "promotable vs blocked" and promotion grouping are ported from the extension's webview (`vscode-extension/webview/index.html`). If that logic changes there, update `src/lib/eligibility.ts` and `src/lib/grouping.ts`.
- Unlike the panel, there is no live test polling: test status is shown as of verification time.
