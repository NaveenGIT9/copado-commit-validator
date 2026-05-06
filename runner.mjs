// Standalone runner — bypasses sf CLI framework entirely for fast startup
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join as pathJoin } from 'path';
import { AuthInfo, Connection, StateAggregator } from '@salesforce/core';
import { simpleGit } from 'simple-git';

function emit(data) {
  process.stdout.write(JSON.stringify(data) + '\n');
}

function parseCopadoError(err) {
  const str = String(err);
  try {
    const match = str.match(/\[.*\]/s);
    if (match) {
      const arr = JSON.parse(match[0]);
      const messages = arr.flatMap(item => (item.errors || []).map(e => e.message)).filter(Boolean);
      if (messages.length > 0) return messages.join('; ');
    }
  } catch { /* fall through */ }
  return str;
}

// Converts SSH git URLs to HTTPS so cloning works without SSH host key setup.
// git@github.com:org/repo.git  →  https://github.com/org/repo.git
function toHttpsUrl(url) {
  if (!url) return url;
  const match = url.match(/^git@([^:]+):(.+)$/);
  if (match) return `https://${match[1]}/${match[2]}`;
  return url; // already https or other — pass through unchanged
}

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, val, i, arr) => {
    if (val.startsWith('--')) acc.push([val.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);

const orgAlias      = args['target-org'] ?? '';
const repoPath      = (args['repo-path'] ?? '').replace(/[>]+$/, '').trim();
const doPromote     = args.promote === 'true';
const doMergeDeploy = args['merge-deploy'] === 'true';
const doFetchReady  = args['fetch-ready'] === 'true';
const fetchEnvType  = args['env-type'] ?? 'QA';

// Extract the GitHub repo name from a Copado git repository URI.
// Handles both HTTPS (https://github.com/Org/Repo-Name.git) and
// SSH (git@github.com:Org/Repo-Name.git) formats.
function repoNameFromUri(uri) {
  if (!uri) return '';
  return uri.replace(/\.git$/, '').split(/[/:]/).pop() ?? '';
}

function parseApiName(filePath) {
  const parts = filePath.replace(/\\/g, '/').split('/');
  const defaultIdx = parts.indexOf('default');
  if (defaultIdx === -1) return null;
  const typeFolder = parts[defaultIdx + 1];
  if (['aura', 'lwc'].includes(typeFolder)) return parts[defaultIdx + 2] ?? null;
  return parts[parts.length - 1].replace(/-meta\.xml$/, '').replace(/\.[^.]+$/, '') || null;
}

async function main() {
  // Resolve alias → username using @salesforce/core StateAggregator (reads local
  // auth files directly — no SF CLI startup cost). Falls back to sf org display
  // if StateAggregator can't resolve the alias.
  let conn;
  try {
    let username = orgAlias;
    try {
      const sa = await StateAggregator.getInstance();
      username = sa.aliases.getUsername(orgAlias) ?? orgAlias;
    } catch {
      // StateAggregator unavailable — fall through to sf CLI fallback below
      username = null;
    }

    if (!username) {
      // Fall back: ask sf CLI (slow ~15s due to plugin loading, but reliable)
      const r = spawnSync('sf', ['org', 'display', '--target-org', orgAlias, '--json'], {
        shell: true, encoding: 'utf8', timeout: 20_000,
      });
      const orgData = JSON.parse(r.stdout ?? '').result;
      if (!orgData?.username) {
        throw new Error(`sf org display returned no username for "${orgAlias}". Is the org authenticated? Run: sf org login web --alias ${orgAlias}`);
      }
      username = orgData.username;
    }

    const authInfo = await AuthInfo.create({ username });
    conn = await Connection.create({ authInfo });
  } catch (err) {
    emit({ type: 'fatal', message: `Auth failed for "${orgAlias}": ${String(err)}` });
    process.exit(1);
  }

  // ── FETCH READY MODE ────────────────────────────────────────────────────────
  if (doFetchReady) {
    const listViewLabel = fetchEnvType === 'UAT' ? 'UAT Deployment' : 'QA Deployment';
    emit({ type: 'fetch-start', envType: fetchEnvType, listViewLabel });

    // Step 1: find the list view by label
    let listViewResultsUrl;
    try {
      const lvRes = await conn.request({
        method: 'GET',
        url: `/services/data/v${conn.version}/sobjects/copado__User_Story__c/listviews`,
      });
      const listView = (lvRes.listviews ?? []).find(lv => lv.label === listViewLabel);
      if (!listView) {
        emit({ type: 'fatal', message: `List view "${listViewLabel}" not found on copado__User_Story__c.` });
        process.exit(1);
      }
      listViewResultsUrl = listView.resultsUrl;
    } catch (err) {
      emit({ type: 'fatal', message: `Failed to fetch list views: ${String(err)}` });
      process.exit(1);
    }

    // Step 2: execute list view to get story records.
    // List view results API puts ALL field values inside row.columns[], not as top-level properties.
    // Find Id and Name by their column index in the header, then read the same index per row.
    let storyIds = [], storyNames = [];
    try {
      const resultsRes = await conn.request({ method: 'GET', url: listViewResultsUrl });
      const headerCols = resultsRes.columns ?? [];
      const idColIdx   = headerCols.findIndex(c => c.fieldNameOrPath === 'Id');
      const nameColIdx = headerCols.findIndex(c => c.fieldNameOrPath === 'Name');
      for (const row of (resultsRes.records ?? [])) {
        const rowCols = row.columns ?? [];
        const id   = idColIdx   >= 0 ? rowCols[idColIdx]?.value   : (row.Id ?? row.id);
        const name = nameColIdx >= 0 ? rowCols[nameColIdx]?.value : (row.Name ?? row.name);
        if (id && name) { storyIds.push(id); storyNames.push(name); }
      }
    } catch (err) {
      emit({ type: 'fatal', message: `Failed to fetch list view results: ${String(err)}` });
      process.exit(1);
    }

    if (storyIds.length === 0) {
      emit({ type: 'fetch-done', stories: [], repoName: '', envType: fetchEnvType });
      process.exit(0);
    }

    emit({ type: 'fetch-stories-found', count: storyIds.length, envType: fetchEnvType });

    // Step 3: fetch latest commit date for all stories in one query
    const latestCommitDateMap = {};
    try {
      const storyIdList = storyIds.map(id => `'${id}'`).join(',');
      const cdRes = await conn.query(
        `SELECT Id, copado__Latest_Commit_Date__c FROM copado__User_Story__c WHERE Id IN (${storyIdList})`
      );
      for (const r of cdRes.records) latestCommitDateMap[r.Id] = r.copado__Latest_Commit_Date__c;
    } catch { /* non-fatal — will skip date check */ }

    // Step 4: per story — check latest promotion status vs latest commit date
    const validStories = [];
    for (let i = 0; i < storyIds.length; i++) {
      const storyId          = storyIds[i];
      const storyName        = storyNames[i];
      const latestCommitDate = latestCommitDateMap[storyId] ?? null;

      // Always include the story — failed-promotion warning is shown during verify.
      validStories.push({ id: storyId, name: storyName });
    }

    // Step 5: get git repo name from first valid story's project → pipeline → git repository
    let repoName = '';
    if (validStories.length > 0) {
      try {
        const storyRec = await conn.query(
          `SELECT copado__Project__r.copado__Deployment_Flow__r.copado__Git_Repository__r.copado__URI__c ` +
          `FROM copado__User_Story__c WHERE Id = '${validStories[0].id}'`
        );
        const uri = storyRec.records[0]
          ?.copado__Project__r
          ?.copado__Deployment_Flow__r
          ?.copado__Git_Repository__r
          ?.copado__URI__c ?? '';
        repoName = repoNameFromUri(uri);
      } catch { /* non-fatal */ }
    }

    emit({ type: 'fetch-done', stories: validStories.map(s => s.name), repoName, envType: fetchEnvType });
    process.exit(0);
  }

  // ── PROMOTE MODE ────────────────────────────────────────────────────────────
  if (doPromote) {
    let groups = [];
    try { groups = JSON.parse(args['groups'] ?? '[]'); } catch { groups = []; }

    const promotionSummary = [];
    const mergeDeployQueue = []; // promotionIds — bulk-triggered after all groups complete
    for (const group of groups) {
      const { projectId, credentialId, stories: groupStories, storyIds } = group;

      // Re-trigger an existing "Conflicts Resolved" promotion — no new record needed.
      if (group.retriggerPromotionId) {
        const pid = group.retriggerPromotionId;
        const promotionName = group.retriggerPromotionName ?? pid;
        emit({ type: 'promotion-retriggered', promotionId: pid, promotionName, projectId, storyCount: groupStories.length });
        promotionSummary.push({ success: true, projectId, destEnvName: '—', promotionName, storyCount: groupStories.length });
        for (const name of groupStories) {
          emit({ type: 'promote-result', storyName: name, success: true, promotionId: pid });
        }
        mergeDeployQueue.push(pid);
        continue;
      }

      let promotionId;
      try {
        // Step 1: Get deployment flow from project
        const projRes = await conn.query(
          `SELECT copado__Deployment_Flow__c FROM copado__Project__c WHERE Id = '${projectId}'`
        );
        const pipelineId = projRes.records[0]?.copado__Deployment_Flow__c;
        if (!pipelineId) throw new Error(`No deployment flow found on project ${projectId}`);

        // Step 2: Get source org name (e.g. "RBKDEV1") — credentialId is a copado__Org__c record
        const credRes = await conn.query(
          `SELECT Name FROM copado__Org__c WHERE Id = '${credentialId}'`
        );
        const srcName = credRes.records[0]?.Name;
        if (!srcName) throw new Error(`Org ${credentialId} not found`);

        // Step 3: Find deployment flow step — get both source and destination environment IDs
        const pcRes = await conn.query(
          `SELECT copado__Source_Environment__c, copado__Destination_Environment__c, copado__Destination_Environment__r.Name ` +
          `FROM copado__Deployment_Flow_Step__c ` +
          `WHERE copado__Deployment_Flow__c = '${pipelineId}' ` +
          `AND copado__Source_Environment__r.Name = '${srcName}'`
        );
        if (pcRes.records.length === 0)
          throw new Error(`No pipeline step found for source '${srcName}' in deployment flow ${pipelineId}`);
        const sourceEnvId = pcRes.records[0].copado__Source_Environment__c;
        const destEnvId   = pcRes.records[0].copado__Destination_Environment__c;
        if (!destEnvId) throw new Error(`Pipeline step has no destination environment`);
        const destEnvName = pcRes.records[0]?.copado__Destination_Environment__r?.Name ?? 'Unknown';

        // Step 3b: Resolve destination credential (a11-prefix Org__c) from an existing promotion
        const destCredRes = await conn.query(
          `SELECT copado__Destination_Org_Credential__c FROM copado__Promotion__c ` +
          `WHERE copado__Destination_Environment__c = '${destEnvId}' LIMIT 1`
        );
        if (destCredRes.records.length === 0)
          throw new Error(`No existing promotion found to determine destination credential for env ${destEnvId}`);
        const destCredId = destCredRes.records[0].copado__Destination_Org_Credential__c;

        // Step 4: Create promotion with source + destination credentials and environments
        const result = await conn.sobject('copado__Promotion__c').create({
          copado__Project__c: projectId,
          copado__Source_Org_Credential__c: credentialId,
          copado__Source_Environment__c: sourceEnvId,
          copado__Destination_Org_Credential__c: destCredId,
          copado__Destination_Environment__c: destEnvId,
          copado__Status__c: 'Draft',
        });
        if (!result.success) throw new Error(result.errors?.join(', ') ?? 'Create failed');
        promotionId = result.id;

        // Fetch the auto-generated promotion name (e.g. P26926)
        const nameRes = await conn.query(`SELECT Name FROM copado__Promotion__c WHERE Id = '${promotionId}'`);
        const promotionName = nameRes.records[0]?.Name ?? promotionId;

        emit({ type: 'promotion-created', promotionId, promotionName, projectId, storyCount: storyIds.length });
        promotionSummary.push({ success: true, projectId, destEnvName, promotionName, storyCount: storyIds.length });
      } catch (err) {
        promotionSummary.push({ success: false, projectId, storyCount: groupStories.length });
        for (const name of groupStories) {
          emit({ type: 'promote-result', storyName: name, success: false, error: `Promotion create failed: ${String(err)}` });
        }
        continue;
      }

      for (let i = 0; i < storyIds.length; i++) {
        const storyId   = storyIds[i];
        const storyName = groupStories[i];
        try {
          await conn.sobject('copado__Promoted_User_Story__c').create({
            copado__Promotion__c: promotionId,
            copado__User_Story__c: storyId,
          });
          emit({ type: 'promote-result', storyName, storyId, success: true, promotionId });
        } catch (err) {
          emit({ type: 'promote-result', storyName, storyId, success: false, error: String(err) });
        }
      }

      // Copy RESOLVED attachments from old Conflicts Resolved promotion to this new one.
      // Copado reads "RESOLVED <storyName> <filepath>" attachments during merge to skip re-resolution.
      // Only copy if story has no new commits after the conflict was resolved — otherwise resolutions are stale.
      if (group.conflictResolvedSourcePromoId) {
        const lcd = group.conflictResolvedLatestCommit;
        const pmd = group.conflictResolvedPromoLastMod;
        if (!lcd || !pmd || new Date(lcd) >= new Date(pmd)) {
          emit({ type: 'debug', message: `attachment copy: skipped — latestCommitDate (${lcd ?? 'null'}) not before promoLastModified (${pmd ?? 'null'})` });
        } else {
          try {
            const storyName = groupStories[0];
            const attRes = await conn.query(
              `SELECT Id, Name, ContentType FROM Attachment ` +
              `WHERE ParentId = '${group.conflictResolvedSourcePromoId}' ` +
              `AND Name LIKE 'RESOLVED ${storyName}%'`
            );
            emit({ type: 'debug', message: `attachment copy: found ${attRes.records.length} RESOLVED attachment(s) for ${storyName}` });
            for (const att of attRes.records) {
              const bodyBase64 = await conn.request({
                url: `/services/data/v${conn.version}/sobjects/Attachment/${att.Id}/Body`,
                encoding: 'base64',
              });
              await conn.sobject('Attachment').create({
                ParentId:    promotionId,
                Name:        att.Name,
                Body:        bodyBase64,
                ContentType: att.ContentType ?? 'application/octet-stream',
              });
            }
            emit({ type: 'debug', message: `attachment copy: copied ${attRes.records.length} attachment(s) to ${promotionId}` });
          } catch (attErr) {
            emit({ type: 'debug', message: `attachment copy failed (non-fatal): ${attErr}` });
          }
        }
      }

      // Collect for bulk Merge & Deploy after all promotions are created
      if (doMergeDeploy) mergeDeployQueue.push(promotionId);
    }

    // Step 5: Sequential PromoteAction calls — one per promotion with a delay between each.
    // Bulk inputs (>1) → Copado rejects all with "Only 1 request is available".
    // Immediate sequential calls → Copado silently drops subsequent ones while first job initialises.
    // Solution: one call at a time, 5-second gap to let Copado register the previous job.
    if (doMergeDeploy && mergeDeployQueue.length > 0) {
      for (let i = 0; i < mergeDeployQueue.length; i++) {
        const pid = mergeDeployQueue[i];
        if (i > 0) await new Promise(r => setTimeout(r, 5000));
        try {
          const actionRes = await conn.request({
            method: 'POST',
            url: `/services/data/v${conn.version}/actions/custom/apex/copado__PromoteAction`,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              inputs: [{ promotionId: pid, executePromotion: true, executeDeployment: true }],
            }),
          });
          emit({ type: 'stderr', message: `PromoteAction [${pid}]: ${JSON.stringify(actionRes)}` });
          const result0 = actionRes?.[0];
          if (!result0?.isSuccess) {
            const errMsg = (result0?.errors || [])
              .map(e => e.message || e.statusCode || JSON.stringify(e)).join('; ')
              || 'PromoteAction returned isSuccess=false';
            emit({ type: 'merge-deploy-error', promotionId: pid, error: errMsg });
          } else {
            const jobExecId = result0?.outputValues?.jobExecution?.Id ?? null;
            emit({ type: 'merge-deploy-started', promotionId: pid, jobExecutionId: jobExecId });

            // Update promotion status to 'In Progress' once Copado creates the queued JE.
            // JE creation is async — retry up to 3x with 2s gap before giving up (non-fatal).
            try {
              let jeFound = false;
              for (let attempt = 0; attempt < 3 && !jeFound; attempt++) {
                if (attempt > 0) await new Promise(r => setTimeout(r, 2000));
                const jeCheck = await conn.query(
                  `SELECT Id FROM copado__JobExecution__c ` +
                  `WHERE copado__Promotion__c = '${pid}' ` +
                  `AND copado__Status__c = 'Queued' ` +
                  `AND copado__Template__r.Name IN ('SFDX Promote', 'SFDX Deploy') ` +
                  `LIMIT 1`
                );
                if (jeCheck.records.length > 0) {
                  jeFound = true;
                  await conn.sobject('copado__Promotion__c').update({ Id: pid, copado__Status__c: 'In Progress' });
                  emit({ type: 'debug', message: `Promotion ${pid}: status set to In Progress (JE confirmed queued)` });
                }
              }
              if (!jeFound) emit({ type: 'debug', message: `Promotion ${pid}: no queued JE found after 3 attempts — status not updated` });
            } catch (statusErr) {
              emit({ type: 'debug', message: `Promotion ${pid}: status update failed (non-fatal): ${statusErr}` });
            }
          }
        } catch (err) {
          emit({ type: 'merge-deploy-error', promotionId: pid, error: parseCopadoError(err) });
        }
      }
    }

    emit({ type: 'promote-summary', promotionSummary });
    emit({ type: 'done' });
    return;
  }

  // ── VERIFY MODE ─────────────────────────────────────────────────────────────
  const storyNames = (args.stories ?? '').split(',').map(s => s.trim()).filter(Boolean);
  emit({ type: 'start', storyNames });

  const nameList = storyNames.map(n => `'${n}'`).join(',');
  let stories = [];
  try {
    const result = await conn.query(
      `SELECT Id, Name, copado__Org_Credential__c, copado__Org_Credential__r.Name, copado__Latest_Commit_Date__c, copado__Project__c, copado__Project__r.Name, copado__Status__c, copado__Pull_Requests_Approved__c, copado__Has_Apex_Code__c, copado__Developer__r.Name ` +
      `FROM copado__User_Story__c WHERE Name IN (${nameList})`
    );
    stories = result.records;
  } catch (err) {
    emit({ type: 'fatal', message: `Copado query failed: ${String(err)}` });
    return;
  }

  const foundNames = new Set(stories.map(r => r.Name));
  for (const name of storyNames) {
    if (!foundNames.has(name)) emit({ type: 'story-error', storyName: name, message: 'Story not found in org' });
  }
  if (stories.length === 0) {
    emit({ type: 'fatal', message: 'No stories found. Check story names and org alias.' });
    return;
  }

  // Detect the git repo URI, pipeline ID, and pipeline name from the first story's project chain.
  let repoUri = '';
  let detectedRepoName = '';
  let detectedPipelineId = '';
  let detectedPipelineName = '';
  try {
    const repoRec = await conn.query(
      `SELECT copado__Project__r.copado__Deployment_Flow__c, ` +
      `copado__Project__r.copado__Deployment_Flow__r.Name, ` +
      `copado__Project__r.copado__Deployment_Flow__r.copado__Git_Repository__r.copado__URI__c ` +
      `FROM copado__User_Story__c WHERE Id = '${stories[0].Id}'`
    );
    const rec = repoRec.records[0];
    repoUri             = rec?.copado__Project__r?.copado__Deployment_Flow__r?.copado__Git_Repository__r?.copado__URI__c ?? '';
    detectedRepoName    = repoNameFromUri(repoUri);
    detectedPipelineId  = rec?.copado__Project__r?.copado__Deployment_Flow__c ?? '';
    detectedPipelineName = rec?.copado__Project__r?.copado__Deployment_Flow__r?.Name ?? '';
  } catch { /* non-fatal */ }

  // Resolve which local git path to use.
  // If --repo-path was given and is a valid git dir, use it.
  // Otherwise auto-clone to a temp dir (once) and reuse on future runs.
  let effectiveRepoPath = repoPath;
  let alreadyFetched = false;

  if (!effectiveRepoPath || !existsSync(pathJoin(effectiveRepoPath, '.git'))) {
    if (!repoUri) {
      emit({ type: 'fatal', message: 'Could not detect git repository URI from Copado. Enter the Git Repo Path manually.' });
      return;
    }
    const tempBase = pathJoin(tmpdir(), 'copado-validator');
    effectiveRepoPath = pathJoin(tempBase, detectedRepoName);

    if (existsSync(pathJoin(effectiveRepoPath, '.git'))) {
      // Repo already cloned previously — just fetch latest
      emit({ type: 'effective-repo-path', repoPath: effectiveRepoPath });
      emit({ type: 'git-fetch-start' });
      const g = simpleGit(effectiveRepoPath);
      try { await g.fetch(['origin']); }
      catch (err) { emit({ type: 'fatal', message: `git fetch failed: ${String(err)}` }); return; }
      emit({ type: 'git-fetch-done' });
      alreadyFetched = true;
    } else {
      // First time — clone without checking out files (faster, we only need git history)
      emit({ type: 'git-clone-start', repoName: detectedRepoName });
      mkdirSync(tempBase, { recursive: true });
      try {
        await simpleGit().clone(toHttpsUrl(repoUri), effectiveRepoPath, ['--no-checkout']);
      } catch (err) {
        emit({ type: 'fatal', message: `git clone failed: ${String(err)}` });
        return;
      }
      emit({ type: 'effective-repo-path', repoPath: effectiveRepoPath });
      emit({ type: 'git-clone-done' });
      alreadyFetched = true;
    }
  } else {
    emit({ type: 'effective-repo-path', repoPath: effectiveRepoPath });
  }

  const git = simpleGit(effectiveRepoPath);
  if (!alreadyFetched) {
    emit({ type: 'git-fetch-start' });
    try { await git.fetch(['origin']); }
    catch (err) { emit({ type: 'fatal', message: `git fetch failed: ${String(err)}` }); return; }
    emit({ type: 'git-fetch-done' });
  }

  // Build a pipeline level map across ALL deployment flow steps in the org.
  // Querying without a pipeline filter covers stories from multiple projects that
  // may belong to different pipelines (e.g. RBKDEV1 pipeline vs RBKMSPDEV pipeline).
  // Example: TRNDEV1(0) → TRNQA(1) → TRNUAT(2) → TRNPROD(3)
  const credLevel = new Map(); // credName → numeric level
  let pipelineEdges = []; // { from, to, fromId, toId }[]
  try {
    const pipelineFilter = detectedPipelineId
      ? ` WHERE copado__Deployment_Flow__c = '${detectedPipelineId}'`
      : '';
    const stepsRes = await conn.query(
      `SELECT copado__Source_Environment__c, copado__Source_Environment__r.Name, ` +
      `copado__Destination_Environment__c, copado__Destination_Environment__r.Name ` +
      `FROM copado__Deployment_Flow_Step__c${pipelineFilter}`
    );
    const edges = stepsRes.records
      .filter(s => s.copado__Source_Environment__r?.Name && s.copado__Destination_Environment__r?.Name)
      .map(s => ({ from: s.copado__Source_Environment__r.Name.toLowerCase(), to: s.copado__Destination_Environment__r.Name.toLowerCase(),
                   fromId: s.copado__Source_Environment__c, toId: s.copado__Destination_Environment__c }));
    pipelineEdges = edges;
    emit({ type: 'debug', message: `pipeline: id=${detectedPipelineId || 'unknown'} loaded ${edges.length} edges: ${edges.map(e=>`${e.from}→${e.to}`).join(', ')}` });

    if (detectedPipelineName) {
      emit({ type: 'pipeline-names', names: [detectedPipelineName] });
    }

    // BFS to assign numeric level to each environment (0 = lowest/source)
    const allDest = new Set(edges.map(e => e.to));
    const roots   = [...new Set(edges.map(e => e.from))].filter(n => !allDest.has(n));
    const queue   = roots.map(n => ({ n, level: 0 }));
    while (queue.length > 0) {
      const { n, level } = queue.shift();
      if (!credLevel.has(n) || credLevel.get(n) < level) {
        credLevel.set(n, level);
        for (const e of edges.filter(e => e.from === n)) {
          queue.push({ n: e.to, level: level + 1 });
        }
      }
    }
  } catch (pipelineErr) { emit({ type: 'debug', message: `pipeline ERROR: ${pipelineErr}` }); }

  for (const story of stories) {
    const branchName   = `feature/${story.Name}`;
    const remoteBranch = `origin/${branchName}`;

    emit({ type: 'story-verifying', storyName: story.Name, branch: branchName });

    // Fetch Copado-registered commits
    let copadoCommits = [];
    try {
      const commitResult = await conn.query(
        `SELECT copado__Snapshot_Commit__r.copado__Commit_Id__c FROM copado__User_Story_Commit__c ` +
        `WHERE copado__User_Story__c = '${story.Id}' AND copado__Status__c = 'Complete'`
      );
      copadoCommits = commitResult.records
        .map(r => r.copado__Snapshot_Commit__r?.copado__Commit_Id__c?.trim())
        .filter(Boolean);
    } catch (err) {
      emit({ type: 'story-error', storyName: story.Name, message: `Commit query failed: ${String(err)}` });
      continue;
    }

    // Fetch non-Complete commit records for this story (e.g. 'Commit not in branch').
    // If an unregistered branch commit matches one of these SHAs the developer pushed
    // old commits back to the branch that were never properly registered — must block.
    let nonCompleteCommitShas = new Set();
    try {
      const ncRes = await conn.query(
        `SELECT copado__Snapshot_Commit__r.copado__Commit_Id__c FROM copado__User_Story_Commit__c ` +
        `WHERE copado__User_Story__c = '${story.Id}' AND copado__Status__c != 'Complete'`
      );
      for (const r of ncRes.records) {
        const sha = r.copado__Snapshot_Commit__r?.copado__Commit_Id__c?.trim().toLowerCase();
        if (sha) nonCompleteCommitShas.add(sha);
      }
      if (nonCompleteCommitShas.size > 0)
        emit({ type: 'debug', message: `${story.Name}: ${nonCompleteCommitShas.size} non-Complete commit SHA(s) found` });
    } catch { /* non-fatal */ }

    // Fetch story metadata component names (for coverage check)
    let storyMetadataNames = new Set();
    try {
      const metaResult = await conn.query(
        `SELECT copado__Metadata_API_Name__c FROM copado__User_Story_Metadata__c ` +
        `WHERE copado__User_Story__c = '${story.Id}'`
      );
      storyMetadataNames = new Set(
        metaResult.records.map(r => r.copado__Metadata_API_Name__c?.toLowerCase()).filter(Boolean)
      );
    } catch { /* non-fatal — coverage check will be skipped */ }

    // Fetch test records
    let storyTests = [];
    try {
      const testResult = await conn.query(
        `SELECT Name, copado__Type__c, copado__Test_Tool__c, copado__Latest_Result_Status__c ` +
        `FROM copado__Test__c WHERE copado__User_Story__c = '${story.Id}'`
      );
      storyTests = testResult.records.map(r => ({
        name: r.Name,
        type: r.copado__Type__c,
        tool: r.copado__Test_Tool__c,
        status: r.copado__Latest_Result_Status__c,
      }));
    } catch { /* non-fatal */ }

    // Fetch job steps — covers all deployment task types (Data Set, Manual Task, etc.)
    let hasDeploymentTasks = false;
    try {
      const dtRes = await conn.query(
        `SELECT COUNT() FROM copado__JobStep__c WHERE copado__UserStory__c = '${story.Id}'`
      );
      hasDeploymentTasks = (dtRes.totalSize ?? 0) > 0;
    } catch { /* non-fatal */ }

    // Collect authors of registered commits (for author comparison)
    const storyAuthorEmails = new Set();
    const storyAuthorNames  = new Set();
    for (const sha of copadoCommits) {
      try {
        const log = await git.raw(['log', '--format=%ae|%an', '-1', sha]);
        const [email, name] = log.trim().split('|');
        if (email) storyAuthorEmails.add(email.toLowerCase());
        if (name)  storyAuthorNames.add(name);
      } catch { /* skip */ }
    }

    // Get all commits on feature branch ahead of master
    let extraCommits = [];
    try {
      const raw = await git.raw(['log', '--format=%H', `origin/master..${remoteBranch}`]);
      extraCommits = raw.split('\n').map(h => h.trim()).filter(Boolean);
    } catch {
      if (copadoCommits.length === 0) {
        // No Copado commits and branch doesn't exist — treat as no-commit story.
        // Fall through to normal verdict flow so parent/lastPromoWarning are still checked.
        extraCommits = [];
      } else {
        emit({ type: 'story-verified', storyName: story.Name, storyId: story.Id,
               projectId: story.copado__Project__c,
               projectName: story.copado__Project__r?.Name ?? 'Unknown Project',
               credentialId: story.copado__Org_Credential__c,
               branch: branchName, extraCommits: [], copadoCommits, unregistered: [],
               unregisteredDetail: [], storyCommittedBy: [...storyAuthorNames],
               extraCommittedBy: [], tests: storyTests,
               prApproved: story.copado__Pull_Requests_Approved__c, hasMetadata: storyMetadataNames.size > 0,
               hasApexCode: story.copado__Has_Apex_Code__c,
               parentStory: null, promotionCount: 0, lastPromotionFailed: false,
               srcEnvName: story.copado__Org_Credential__r?.Name ?? null,
               dstEnvName: (() => { const s = story.copado__Org_Credential__r?.Name ?? null; return s ? (pipelineEdges.find(e => e.from === s.toLowerCase())?.to ?? null) : null; })(),
               verdict: 'error', message: `Branch ${remoteBranch} not found. Check that the correct repo is cloned locally and the path is set correctly.` });
        continue;
      }
    }

    const copadoSet    = new Set(copadoCommits);
    const unregistered = extraCommits.filter(h => !copadoSet.has(h));

    // Deep analysis of each unregistered commit.
    // Also track the latest committer date across all unregistered commits — used for the
    // CR stale-resolution check (more accurate than copado__Latest_Commit_Date__c which
    // only reflects Copado-registered commits; unregistered commits may be newer).
    let latestUnregisteredCommitDate = null;
    const unregisteredDetail = [];
    for (const sha of unregistered) {
      let files = [];
      try {
        const raw = await git.raw(['diff-tree', '--no-commit-id', '-r', '--name-only', sha]);
        files = raw.split('\n').map(f => f.trim()).filter(Boolean);
      } catch { /* skip */ }

      let authorEmail = '', authorName = '', committerEmail = '', committerName = '', commitDate = '';
      try {
        const log = await git.raw(['log', '--format=%ae|%an|%ce|%cn|%cI', '-1', sha]);
        [authorEmail, authorName, committerEmail, committerName, commitDate] = log.trim().split('|');
      } catch { /* skip */ }
      if (commitDate && (!latestUnregisteredCommitDate || new Date(commitDate) > new Date(latestUnregisteredCommitDate))) {
        latestUnregisteredCommitDate = commitDate;
      }
      const isAmended = !!(authorEmail && committerEmail && authorEmail.toLowerCase() !== committerEmail.toLowerCase());

      let commitMessage = '';
      try {
        commitMessage = (await git.raw(['log', '--format=%s', '-1', sha])).trim();
      } catch { /* skip */ }

      const copadoAuto = commitMessage.startsWith('Updated sourceApiVersion from')
        || commitMessage.startsWith('Clear custom_rulesets in code-analyzer.yml')
        || commitMessage.startsWith('Add custom PMD rules to custom-rules-list.txt');

      const components        = [...new Set(files.map(parseApiName).filter(Boolean))];
      const coveredComponents   = components.filter(c => storyMetadataNames.has(c.toLowerCase()));
      const uncoveredComponents = components.filter(c => !storyMetadataNames.has(c.toLowerCase()));
      const authorMismatch      = authorEmail ? !storyAuthorEmails.has(authorEmail.toLowerCase()) : false;

      // Check if this unregistered SHA matches a Copado commit record with non-Complete status.
      // Copado may store abbreviated SHAs — compare both directions.
      const shaLower = sha.toLowerCase();
      const commitNotInBranch = nonCompleteCommitShas.size > 0 && [...nonCompleteCommitShas].some(
        nc => shaLower.startsWith(nc) || nc.startsWith(shaLower)
      );

      unregisteredDetail.push({
        sha: sha.substring(0, 10), authorName, authorEmail, committerName, isAmended, commitMessage,
        components, coveredComponents, uncoveredComponents, authorMismatch, copadoAuto, commitNotInBranch,
      });
    }

    const extraCommittedBy = [...new Set(unregisteredDetail.map(d => d.authorName).filter(Boolean))];

    // Check if this story's Base Branch points to another story's feature branch.
    // If yes, that parent story must be in a higher environment before this one deploys.
    // Source: copado__Base_Branch__c field (e.g. "feature/US-0004674") — no git needed.
    let parentStory = null; // { name: string, promoted: boolean } | null
    try {
      const baseBranchRes = await conn.query(
        `SELECT copado__Base_Branch__c FROM copado__User_Story__c WHERE Id = '${story.Id}'`
      );
      const baseBranch = baseBranchRes.records[0]?.copado__Base_Branch__c ?? '';
      const parentMatch = baseBranch.match(/US-\d+/);
      if (parentMatch) {
        const parentName = parentMatch[0];
        const parentRes = await conn.query(
          `SELECT copado__Org_Credential__r.Name FROM copado__User_Story__c WHERE Name = '${parentName}' LIMIT 1`
        );
        const parentCredName  = parentRes.records[0]?.copado__Org_Credential__r?.Name ?? null;
        const currentCredName = story.copado__Org_Credential__r?.Name ?? null;
        const currentLevel = currentCredName ? (credLevel.get(currentCredName.toLowerCase()) ?? -1) : -1;
        const parentLevel  = parentCredName  ? (credLevel.get(parentCredName.toLowerCase())  ?? -1) : -1;

        let parentPromoted;
        if (parentCredName && currentCredName && parentCredName === currentCredName) {
          // Same credential = same environment → parent not yet promoted
          parentPromoted = false;
        } else if (currentLevel >= 0 && parentLevel >= 0) {
          // Both found in pipeline map → compare positions
          parentPromoted = parentLevel > currentLevel;
        } else {
          // Different credentials but pipeline map unavailable → skip (no false blocks)
          parentPromoted = true;
        }
        parentStory = { name: parentName, promoted: parentPromoted };
      }
    } catch { /* non-fatal */ }

    // Count how many times this story has been successfully promoted (for re-deploy badge).
    let promotionCount = 0;
    try {
      const countRes = await conn.query(
        `SELECT COUNT() FROM copado__Promoted_User_Story__c ` +
        `WHERE copado__User_Story__c = '${story.Id}' ` +
        `AND copado__Promotion__r.copado__Status__c = 'Completed'`
      );
      promotionCount = countRes.totalSize ?? 0;
    } catch { /* non-fatal */ }

    // Compute env names once — used both for lastPromoWarning comparison and the env column.
    // Name-based lookup is more reliable than ID-based: the story's Org__c record and the
    // pipeline step's Org__c record may be different objects pointing to the same environment.
    const srcEnvName = story.copado__Org_Credential__r?.Name ?? null;
    const dstEnvName = srcEnvName
      ? (pipelineEdges.find(e => e.from === srcEnvName.toLowerCase())?.to ?? null)
      : null;
    emit({ type: 'debug', message: `env ${story.Name}: credName=${srcEnvName} → dst=${dstEnvName ?? 'NOT FOUND'}` });

    // Check if the story's latest promotion (same source credential) is in a warning state.
    // Filtering by copado__Source_Org_Credential__c ensures we only consider promotions from
    // the same pipeline step as the story — important for attachment copy correctness.
    let lastPromoWarning = null; // { status, name, id } | null
    try {
      const latestCommitDate = story.copado__Latest_Commit_Date__c ?? null;
      const soql =
        `SELECT Id, Name, copado__Status__c, CreatedDate, LastModifiedDate ` +
        `FROM copado__Promotion__c ` +
        `WHERE Id IN (SELECT copado__Promotion__c FROM copado__Promoted_User_Story__c WHERE copado__User_Story__c = '${story.Id}') ` +
        `AND copado__Source_Org_Credential__c = '${story.copado__Org_Credential__c}' ` +
        `ORDER BY CreatedDate DESC LIMIT 1`;
      const promoRes = await conn.query(soql);
      const promo = promoRes.records[0];
      emit({ type: 'debug', message: `promo ${story.Name}: latest = ${promo ? `${promo.Name} | status=${promo.copado__Status__c} | created=${promo.CreatedDate}` : 'none'}` });
      const promoStatus = promo?.copado__Status__c;
      // Always check for a live (Queued or In Progress) SFDX JE — irrespective of promotion status.
      // A live JE is the authoritative current state and takes priority over copado__Status__c.
      let liveJe = null;
      if (promo) {
        try {
          // SFDX Promote JE: links via copado__Promotion__c (direct lookup to Promotion).
          // SFDX Deploy JE:  links via copado__Deployment__c (also a direct lookup to the Promotion record —
          //                  confirmed: copado__Deployment__r.Name returns the Promotion Name e.g. P27095).
          // Check Deploy first (created after Promote completes); fall back to Promote if Deploy not yet created.
          let deployJe = null;
          try {
            const deployRes = await conn.query(
              `SELECT Id, Name, copado__Status__c, CreatedDate, copado__Template__r.Name FROM copado__JobExecution__c ` +
              `WHERE copado__Deployment__c = '${promo.Id}' ` +
              `AND copado__Status__c IN ('Queued', 'In Progress') ` +
              `ORDER BY CreatedDate DESC LIMIT 1`
            );
            deployJe = deployRes.records[0] ?? null;
          } catch (e) {
            emit({ type: 'debug', message: `${story.Name}: deployJe query error: ${e.message}` });
          }

          let promoteJe = null;
          if (!deployJe) {
            const promoteRes = await conn.query(
              `SELECT Id, Name, copado__Status__c, CreatedDate, copado__Template__r.Name FROM copado__JobExecution__c ` +
              `WHERE copado__Promotion__c = '${promo.Id}' ` +
              `AND copado__Status__c IN ('Queued', 'In Progress') ` +
              `ORDER BY CreatedDate DESC LIMIT 1`
            );
            promoteJe = promoteRes.records[0] ?? null;
          }

          liveJe = deployJe ?? promoteJe ?? null;
          emit({ type: 'debug', message: `${story.Name}: live JE for ${promo.Name} → deploy:${deployJe?.copado__Status__c ?? 'none'} promote:${promoteJe?.copado__Status__c ?? 'none'} using:${liveJe?.copado__Status__c ?? 'none'}` });
        } catch (jeErr) {
          emit({ type: 'debug', message: `${story.Name}: liveJe query error: ${jeErr.message}` });
        }
      }

      if (liveJe) {
        lastPromoWarning = { status: 'In Progress', name: promo.Name, id: promo.Id, createdDate: liveJe.CreatedDate, jeStatus: liveJe.copado__Status__c };
      } else {
      // 'In Progress' is handled exclusively via the liveJe block above (JE status is authoritative).
      // Promotion copado__Status__c = 'In Progress' was set by us after PromoteAction — not reliable
      // as a standalone signal because the JE may have already completed by the time verify runs.
      const warningStatuses = ['Completed with errors', 'Merge Conflict', 'Conflicts Resolved', 'Validated', 'Validation failed'];
      if (promo && warningStatuses.includes(promoStatus)) {
        // Stale promotion check: if a new commit was registered AFTER the promotion was last modified,
        // the promotion is no longer relevant — ignore it entirely, lastPromoWarning stays null.
        // copado__Latest_Commit_Date__c is a DateTime field — comparison is precise to the minute.
        const isStalePromo = latestCommitDate && new Date(latestCommitDate) > new Date(promo.LastModifiedDate);
        if (isStalePromo) {
          emit({ type: 'debug', message: `promo ${story.Name}: stale — commitDate=${latestCommitDate} > promoLastMod=${promo.LastModifiedDate}, ignoring ${promo.Name}` });

        } else if (promoStatus === 'Merge Conflict') {
          // 1. Find culprit story from job execution error message.
          let conflictCulprit = null;
          try {
            const jeRes = await conn.query(
              `SELECT copado__ErrorMessage__c FROM copado__JobExecution__c ` +
              `WHERE copado__Promotion__c = '${promo.Id}' AND copado__Status__c = 'Error' ` +
              `ORDER BY CreatedDate DESC LIMIT 1`
            );
            const errMsg = jeRes.records[0]?.copado__ErrorMessage__c ?? '';
            const match = errMsg.match(/merging feature\/(US-\d+)/i);
            conflictCulprit = match?.[1] ?? null;
            emit({ type: 'debug', message: `conflict ${promo.Name}: culprit=${conflictCulprit ?? 'unknown'} | err=${errMsg.slice(0, 120)}` });
          } catch (jeErr) {
            emit({ type: 'debug', message: `conflict JE query error ${story.Name}: ${jeErr}` });
          }

          const isConflictOnCurrentStory = !conflictCulprit || conflictCulprit.toUpperCase() === story.Name.toUpperCase();

          // 2. For non-culprit stories: determine merge position using commit date ordering.
          // Stories are merged into the promotion branch in ascending order of their latest commit date
          // (using the last commit BEFORE the promotion was created as the effective date).
          let mergedIntoPromotion = null; // true = merged before culprit, false = not yet attempted, null = unknown
          if (!isConflictOnCurrentStory && conflictCulprit) {
            try {
              // Get all stories in the promotion with their latest commit dates.
              const storyListRes = await conn.query(
                `SELECT copado__User_Story__c, copado__User_Story__r.Name, ` +
                `copado__User_Story__r.copado__Latest_Commit_Date__c ` +
                `FROM copado__Promoted_User_Story__c WHERE copado__Promotion__c = '${promo.Id}'`
              );

              // Resolve effective commit date for each story:
              // If latest commit date > promo.CreatedDate, use the last commit BEFORE promo creation instead.
              const promoCreated = new Date(promo.CreatedDate);
              const storyDates = {};
              for (const rec of storyListRes.records) {
                const sName = rec.copado__User_Story__r?.Name;
                const sId   = rec.copado__User_Story__c;
                if (!sName) continue;
                let effectiveDate = new Date(rec.copado__User_Story__r?.copado__Latest_Commit_Date__c ?? 0);
                if (effectiveDate >= promoCreated) {
                  // Latest commit was made after promo was created — find the last commit before promo creation.
                  try {
                    const commitRes = await conn.query(
                      `SELECT CreatedDate FROM copado__User_Story_Commit__c ` +
                      `WHERE copado__User_Story__c = '${sId}' AND CreatedDate < ${promo.CreatedDate} ` +
                      `ORDER BY CreatedDate DESC LIMIT 1`
                    );
                    effectiveDate = commitRes.records[0]
                      ? new Date(commitRes.records[0].CreatedDate)
                      : new Date(0);
                  } catch { effectiveDate = new Date(0); }
                }
                storyDates[sName.toUpperCase()] = effectiveDate;
              }

              const culpritDate  = storyDates[conflictCulprit.toUpperCase()];
              const currentDate  = storyDates[story.Name.toUpperCase()];
              if (culpritDate && currentDate) {
                mergedIntoPromotion = currentDate < culpritDate;
              }
              emit({ type: 'debug', message: `merge order ${story.Name}: effectiveDate=${currentDate?.toISOString()} culpritDate=${culpritDate?.toISOString()} merged=${mergedIntoPromotion}` });
            } catch (orderErr) {
              emit({ type: 'debug', message: `merge order error ${story.Name}: ${orderErr}` });
            }
          }

          lastPromoWarning = { status: promoStatus, name: promo.Name, id: promo.Id, conflictCulprit, isConflictOnCurrentStory, mergedIntoPromotion };

        } else {
          // 'Completed with errors' or 'Conflicts Resolved'
          const storyCountRes = await conn.query(
            `SELECT COUNT() FROM copado__Promoted_User_Story__c WHERE copado__Promotion__c = '${promo.Id}'`
          );
          const storyCount = storyCountRes.totalSize ?? 0;
          emit({ type: 'debug', message: `promo ${story.Name}: story count in ${promo.Name} = ${storyCount}` });

          if (storyCount === 1 || promoStatus === 'Completed with errors'
              || promoStatus === 'Validated' || promoStatus === 'Validation failed') {
            // Stale gate already passed — no new commit since this promotion.
            lastPromoWarning = { status: promoStatus, name: promo.Name, id: promo.Id };

          } else if (promoStatus === 'Conflicts Resolved') {
            // Multi-story Conflicts Resolved — emit sibling story names so the UI can decide
            // whether all siblings are present in the current verify list (safe to re-trigger together)
            // or some are missing (fall back to separate new promotion).
            const sibRes = await conn.query(
              `SELECT copado__User_Story__r.Name, copado__User_Story__r.copado__Org_Credential__r.Name ` +
              `FROM copado__Promoted_User_Story__c ` +
              `WHERE copado__Promotion__c = '${promo.Id}'`
            );
            const siblingStories = sibRes.records
              .map(r => ({
                name:       r.copado__User_Story__r?.Name,
                credential: r.copado__User_Story__r?.copado__Org_Credential__r?.Name ?? null,
              }))
              .filter(s => s.name)
              .filter(s => s.name.toUpperCase() !== story.Name.toUpperCase());
            lastPromoWarning = { status: promoStatus, name: promo.Name, id: promo.Id, siblingStories, lastModifiedDate: promo.LastModifiedDate };
          }
        }
      }
      } // closes else { (no live SFDX JE)
    } catch (promoErr) { emit({ type: 'debug', message: `promo ERROR ${story.Name}: ${promoErr}` }); }

    // Refined verdict — copado auto-commits (sourceApiVersion bumps) are always exempt
    const effectiveUnregistered = unregisteredDetail.filter(d => !d.copadoAuto);
    const allCovered    = effectiveUnregistered.length === 0 || effectiveUnregistered.every(d => d.uncoveredComponents.length === 0);
    const allSameAuthor = effectiveUnregistered.every(d => !d.authorMismatch);
    // Block if any unregistered commit matches a Copado record with non-Complete status —
    // developer pushed old commits back to the branch that were never properly registered.
    const hasCommitNotInBranch = unregisteredDetail.some(d => d.commitNotInBranch);

    const verdict = extraCommits.length === 0        ? 'skip-no-commits'
      : unregistered.length === 0                    ? 'clean'
      : effectiveUnregistered.length === 0           ? 'clean'
      : hasCommitNotInBranch                         ? 'skip-unregistered'
      : !allCovered                                  ? 'skip-unregistered'
      : !allSameAuthor                               ? 'skip-needs-verify'
      : 'skip-covered-same-author';

    emit({
      type: 'story-verified',
      storyName: story.Name, storyId: story.Id,
      projectId: story.copado__Project__c,
      projectName: story.copado__Project__r?.Name ?? 'Unknown Project',
      credentialId: story.copado__Org_Credential__c,
      branch: branchName, extraCommits, copadoCommits, unregistered,
      unregisteredDetail, storyCommittedBy: [...storyAuthorNames], extraCommittedBy,
      storyDeveloper: story.copado__Developer__r?.Name ?? null,
      tests: storyTests,
      prApproved: story.copado__Pull_Requests_Approved__c, hasMetadata: storyMetadataNames.size > 0,
      hasApexCode: story.copado__Has_Apex_Code__c, hasDeploymentTasks,
      parentStory, promotionCount, lastPromoWarning,
      latestCommitDate: story.copado__Latest_Commit_Date__c ?? null,
      latestUnregisteredCommitDate,
      srcEnvName, dstEnvName,
      verdict,
    });
  }

  emit({ type: 'done' });
}

main().catch(err => {
  emit({ type: 'fatal', message: String(err) });
  process.exit(1);
});
