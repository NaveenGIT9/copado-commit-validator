# Copado Commit Validator — Installation Guide (v1.0)

## What Is This?

A VSCode extension that automates the verification of Copado User Story commits before promotion. Instead of manually checking each story's commits in Copado, paste story names, click **Verify**, and the tool checks everything automatically — commit registration, test results, PR approvals, and Apex test class presence.

---

## Prerequisites

Before installing the extension, make sure you have the following on your machine:

| Requirement | Details |
|---|---|
| **Node.js** | Version 18 or higher |
| **Salesforce CLI** | `sf` CLI installed and your Copado org authenticated (`sf org login web --alias your-alias`) |
| **Git** | Installed and your Salesforce project repository cloned locally |

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
2. Enter your **SF org alias** (the alias you used when authenticating with `sf org login`)
3. Enter the **local path** of your Salesforce project repository (e.g. `D:\Projects\my-sf-repo`)
4. Click **Verify Stories**
5. Once verification completes, eligible stories appear — click **Promote Eligible Stories** to promote

---

## Does This GitHub Repo Need to Be Cloned?

**No.** You only need to download the `promoter-latest.vsix` file. Cloning this `copado-commit-validator` repository is only needed if you want to read or modify the source code.

What you **do** need cloned locally is your **own Salesforce project repository** — the tool runs git commands against it to verify commits on each feature branch.

---

## Does Making the Repo Private Affect an Already-Installed Extension?

**No.** Once the VSIX is downloaded and installed, it runs entirely on your local machine. It connects only to:
- Your **Salesforce org** (via SF CLI authentication)
- Your **local Salesforce project repository** (via git commands)

It never connects back to GitHub after installation. Private or public makes no difference once installed.

---

## Sharing with Team Members

1. Add them as a **Collaborator** on this GitHub repo (Settings → Collaborators → Add people)
2. They download `promoter-latest.vsix` and follow Steps 1–3 above
3. They need their own Copado org authenticated and their Salesforce project repository cloned locally
4. Done — no other setup required

---

## Version

**v1.0** — Initial release
