# Copado Commit Validator — Installation Guide

## What Is This?

A VS Code extension that checks your Copado User Story commits before promotion and lets you promote directly from the tool. Paste story names, click **Verify**, and it checks commit registration, PR approvals, merge conflicts, parent dependencies, and more — then promotes eligible stories in one click.

---

## For Colleagues — Just Install the VSIX

You only need one file: **`promoter-latest.vsix`** (shared directly by Naveen).

### Prerequisites

Make sure you have these on your machine:

| Requirement | How to check |
|---|---|
| **VS Code** | Already installed |
| **Node.js 18+** | Run `node --version` in terminal |
| **Salesforce CLI** | Run `sf --version` in terminal |
| **Git** | Run `git --version` in terminal |
| **Copado org authenticated** | Run `sf org list` — your org alias should appear |
| **SF repo cloned locally** | e.g. `D:\Projects\rbk-sfdc-release` |

### Install Steps

1. Open VS Code
2. Click the **Extensions** icon in the left sidebar
3. Click the **`...`** menu at the top right of the Extensions panel
4. Select **Install from VSIX...**
5. Select the `promoter-latest.vsix` file
6. Reload VS Code when prompted

### Open the Extension

Press `Ctrl+Shift+P` → type **Copado Commit Validator** → press Enter

### Using It

1. Enter your **Copado org alias** (same alias you use with `sf` CLI)
2. Enter the **path to your local SF repo** (e.g. `D:\Projects\rbk-sfdc-release`)
3. Paste story names — one per line or comma-separated
4. Click **Verify Stories**
5. Review results → click **Promote Eligible Stories**

---

## Do I Need to Clone This Repo?

**No.** The VSIX is fully self-contained — all dependencies are bundled inside it.

What you **do** need cloned is your **own Salesforce project repo** (e.g. `rbk-sfdc-release`) — the tool runs git commands against it to check commits on each feature branch.

---

## Updating to a New Version

When Naveen shares a newer VSIX:

1. Go to Extensions → find **Copado Commit Validator** → click **Uninstall**
2. Follow the install steps above with the new file

---

## For Developers (Making Changes)

### First-time setup

```
cd D:\plugin-promoter\vscode-extension
npm install
```

### After changing runner.mjs or index.html

```
cd D:\plugin-promoter\vscode-extension
npm run build
npx vsce package --no-dependencies --out promoter-latest.vsix
```

Share the new `promoter-latest.vsix` with colleagues. That's it — no other files needed.

### What `npm run build` does

1. Compiles TypeScript → `dist/panel.js`
2. Bundles `runner.mjs` + all npm dependencies → `runner.bundle.js`

Both are packaged into the VSIX automatically.
