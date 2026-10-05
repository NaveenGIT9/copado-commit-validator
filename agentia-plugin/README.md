# agentia-ccv

Copado Commit Validator for the [agentia](https://www.npmjs.com/package/@copado/agentia-cli) CLI. Verify and promote Copado User Stories **from the terminal** - no VS Code extension needed. It uses the same logic as the Copado Commit Validator VS Code extension.

```
agentia verify -s US-0031309,US-0028426        # verify stories, print a table
agentia deploy-plan -s US-0031309,US-0028426   # show how promotions would be created (changes nothing)
agentia deploy -s US-0031309,US-0028426        # promote the promotable stories with Merge & Deploy
```

---

## Setup (one time, about 5 minutes)

### Step 1 - Check you have the tools

Open a terminal and run these commands. Each should print a version number.

```
node -v          # needs 18 or newer
git --version
sf --version     # Salesforce CLI
agentia --version
```

If `agentia` is not found, install it first:

```
npm install -g @copado/agentia-cli
```

### Step 2 - Log in to the Copado org

The commands use your Salesforce CLI login. Replace `MyOrg` with any name you like:

```
sf org login web --alias MyOrg --set-default
```

A browser opens - log in to the Copado org. (If you skip `--set-default`, add `--target-org MyOrg` to every command.)

### Step 3 - Make sure git can reach the pipeline repo

The tool downloads the pipeline repo (for example `Rubrik-IT-Apps/rbk-sfdx-release`) once, and it cannot ask for a password. Check that git already has access:

```
git ls-remote https://github.com/Rubrik-IT-Apps/rbk-sfdx-release
```

- It prints a list of branches: you are fine.
- It says *Repository not found* or asks to sign in: sign in to GitHub in the window that appears. If your default git account has no access to this repo, you will add `--git-user <your-github-account>` to the commands below (see Troubleshooting).

### Step 4 - Install the plugin

Run these five commands, one after the other. Keep the downloaded folder - agentia uses it.

```
git clone --depth 1 --branch feature/v2.0 https://github.com/NaveenGIT9/copado-commit-validator.git
cd copado-commit-validator/agentia-plugin
npm install
npm run build
agentia plugins link .
```

What each one does:
1. Downloads this repo.
2. Goes into the plugin folder (`agentia-plugin`).
3. Installs the plugin's dependencies.
4. Builds the plugin.
5. Connects the plugin to agentia.

You may see a warning *"linked ESM module and cannot be auto-transpiled"* - it is harmless.

### Step 5 - Check it works

```
agentia verify --help
```

If you see the help text for `verify`, you are done. Try it on a real story:

```
agentia verify -s US-0031309
```

---

## Using the commands

| Goal | Command |
|---|---|
| Verify one story | `agentia verify -s US-0031309` |
| Verify several stories | `agentia verify -s US-0031309,US-0028426` |
| See how promotions would be created (changes nothing) | `agentia deploy-plan -s US-0031309,US-0028426` |
| Same, one promotion per source environment | `agentia deploy-plan -s US-0031309,US-0028426 --group-by env` |
| Promote (asks `[y/N]` first) | `agentia deploy -s US-0031309,US-0028426` |
| Promote, one promotion per source environment | `agentia deploy -s US-0031309,US-0028426 --group-by env` |
| Promote without the question | `agentia deploy -s US-0031309,US-0028426 --yes` |

A good habit: run `deploy-plan` first. It prints the exact `deploy` command to run for the plan it shows.

### What each command does

**`verify`** checks each story branch against Copado: unregistered commits, metadata coverage, tests, PR approval, parent/dependency stories and existing promotions. It prints a table, then details only for stories with unregistered commits, blockers or warnings. Exit code is `1` if any story is not promotable.

**`deploy-plan`** verifies the stories and prints the **promotion plan** as a table: which stories go into which promotion, grouped by project (default) or by source environment (`--group-by env`), with each story's source environment and the destination. It never creates or changes anything in Copado.

**`deploy`** verifies first, then creates the promotions and triggers Merge & Deploy.
- Only promotable stories are deployed. Blocked, not-found and "promotion in progress" stories are left out and reported (exit code `1` if any were left out).
- Stories already in a **Conflicts Resolved** promotion re-trigger that promotion; a **Validated** one is deploy-only.
- It shows the plan and asks `[y/N]`. `--yes` skips the question. With no terminal and no `--yes` it refuses to run.
- Merge & Deploy is only *queued* in Copado. The command does not wait for the deployment job to finish.

### Flags

| Flag | Purpose |
|---|---|
| `-s, --stories` | Story names, comma-separated or repeat the flag |
| `-o, --target-org` | Copado org alias (default: your `sf` default org) |
| `--git-user` (or env `CCV_GIT_USER`) | GitHub account git should use for the pipeline repo |
| `--repo-path` | Use an existing local clone of the pipeline repo instead of the temp clone |
| `--group-by project\|env` | (`deploy-plan`, `deploy`) one promotion per project + credential (default), or per source environment |
| `--details` | Print the full per-story card after the table |
| `-y, --yes` | (`deploy`) skip the confirmation question |

Run the commands from a folder where `sf` has a default org, or add `--target-org <alias>`.

---

## Updating

When there is a new version, from the folder you cloned:

```
cd copado-commit-validator
git pull
cd agentia-plugin
npm install
npm run build
```

No need to link again.

## Removing

```
agentia plugins uninstall @naveengit9/agentia-ccv
```

---

## Troubleshooting

| What you see | What to do |
|---|---|
| `Repository not found` / the hint about git authentication | Git is using a GitHub account that has no access to the pipeline repo. Add `--git-user <your-github-account>` (for example `agentia verify -s US-0031309 --git-user my-github-name`), or set it once with `setx CCV_GIT_USER my-github-name` (Windows) and open a new terminal. |
| `No target org found` | Log in with `sf org login web --alias MyOrg --set-default`, or add `--target-org MyOrg`. |
| agentia says `verify` (or `deploy`, `deploy-plan`) is not a command | The plugin is not linked. Repeat Step 4's last command (`agentia plugins link .`) from the `agentia-plugin` folder, then run `agentia plugins` to confirm `@naveengit9/agentia-ccv` is listed. |
| It worked, then stopped after you moved or deleted the cloned folder | agentia points at that folder. Clone again and repeat Step 4. |
| `Story not found in org` | Check the story number and that you are logged in to the right org. |

---

## With the VS Code extension

If you already have the Copado Commit Validator VS Code extension installed, you can skip Step 4: run **Copado Commit Validator: Install agentia commands** from the Command Palette (`Ctrl+Shift+P`). It does the same download, build and link for you.

`agentia open CCV` (opens the extension dashboard) only works if the extension is installed - terminal-only users can ignore it.

## Notes

- Eligibility ("promotable vs blocked") and promotion grouping are ported from the extension's webview (`vscode-extension/webview/index.html`). If that logic changes there, update `src/lib/eligibility.ts` and `src/lib/grouping.ts`.
- Unlike the panel, there is no live test polling: test status is shown as of verification time.
- Built and tested against agentia `0.119.0-alpha.0`.
