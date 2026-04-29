# Copado Commit Validator — Installation Guide (v1.0)

## What Is This?

A VSCode extension that automates the verification of Copado User Story commits before promotion. Instead of manually checking each story's commits in Copado, paste story names, click **Verify**, and the tool checks everything automatically — commit registration, test results, PR approvals, and Apex test class presence.

---

## Prerequisites

Before installing the extension, make sure you have the following on your machine:

| Requirement | Details |
|---|---|
| **Node.js** | Version 18 or higher |
| **Salesforce CLI** | `sf` CLI installed and your org authenticated (`sf org login web --alias your-alias`) |
| **Git** | Installed and the `rbk-sfdc-release` Salesforce repo cloned locally |

---

## Installation Steps

### Step 1 — Download the VSIX

1. Go to the GitHub repository
2. Navigate to `vscode-extension/` folder
3. Click `promoter-latest.vsix`
4. Click **Download raw file**

### Step 2 — Install in VS Code

**Option A — via Extensions Sidebar:**
1. Open VS Code
2. Click the Extensions icon in the sidebar
3. Click the `...` (three dots) at the top right
4. Select **Install from VSIX...**
5. Browse to and select the downloaded `promoter-latest.vsix`

**Option B — via Command Palette:**
1. Press `Ctrl+Shift+P`
2. Type `Install from VSIX`
3. Select the downloaded file

### Step 3 — Open the Panel

1. Press `Ctrl+Shift+P`
2. Type **Copado Commit Validator**
3. Press Enter — the panel opens

---

## Using the Tool

1. Paste your story names (one per line or comma-separated) in the **User Stories** field
2. Enter your **SF org alias** (the one you authenticated with `sf org login`)
3. Enter the **local path** of your cloned `rbk-sfdc-release` repository (e.g. `D:\MyRepos\rbk-sfdc-release`)
4. Click **Verify Stories**
5. Once verification completes, eligible stories appear — click **Promote Eligible Stories** to promote

---

## Does the GitHub Repo Need to Be Cloned?

**No.** You only need to download the `promoter-latest.vsix` file. Cloning the `copado-commit-validator` repository itself is only needed if you want to read or modify the source code.

What you **do** need cloned locally is the **Salesforce repository** (`rbk-sfdc-release`) — the tool runs git commands against it to verify commits.

---

## Does Making the Repo Private Affect an Already-Installed Extension?

**No.** Once the VSIX is downloaded and installed, it runs entirely on your local machine. It connects only to:
- Your **Salesforce org** (via SF CLI authentication)
- Your **local git repository** (via git commands)

It never connects back to GitHub after installation. Private or public makes no difference once installed.

---

## Sharing with Team Members

1. Add them as a **Collaborator** on this GitHub repo (Settings → Collaborators → Add people)
2. They download `promoter-latest.vsix` and follow Steps 1–3 above
3. They need their own SF org authenticated and the Salesforce repo cloned locally
4. Done — no other setup required

---

## Version

**v1.0** — Initial release
