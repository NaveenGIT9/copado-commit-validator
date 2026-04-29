# Copado Commit Validator — v2.0 Changes

## What's New

### 1. Fetch Ready Stories from Copado List Views

No more manually typing story names. Two new buttons replace the manual entry:

- **Fetch QA Ready** — pulls all stories from the **QA Deployment** list view in Copado
- **Fetch UAT Ready** — pulls all stories from the **UAT Deployment** list view in Copado

Stories populate the verification input automatically. Just click, verify, and promote.

---

### 2. Auto-Uncheck Failed Stories

When fetching ready stories, the tool automatically checks each story's latest promotion:

- If the latest promotion status is **Completed with Errors** AND the story's `Latest Commit Date` is older than (or equal to) the promotion failure date → the developer has not taken any action
- The tool automatically **unchecks Ready to Promote** on that story in Copado and excludes it from the fetch results
- If the story has a **newer commit** after the failed promotion → the developer fixed it → story is included as normal

This prevents re-promoting stories that failed and were never addressed.

---

### 3. Auto-Populate Org Alias

The **Target Org Alias** field is now auto-populated from the VS Code default Salesforce org (read from `~/.sf/config.json`). No manual entry needed — the field displays the detected org on panel open.

---

### 4. Auto-Populate Git Repo Path

The **Git Repo Path** is now auto-detected by querying Copado:

`Story → Project → Pipeline → Git Repository`

The tool matches the Copado git repository name against VS Code workspace folders to resolve the correct local path automatically.

---

## Summary of Changes

| Area | v1.0 | v2.0 |
|---|---|---|
| Story input | Manual paste | Fetch QA / UAT Ready buttons |
| Failed promotions | Manually tracked | Auto-unchecked in Copado |
| Org alias | Manual entry | Auto-detected from SF config |
| Git repo path | Manual entry | Auto-detected from Copado pipeline |
