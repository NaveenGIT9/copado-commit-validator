// Standalone runner — bypasses sf CLI framework entirely for fast startup
import { AuthInfo, Connection } from '@salesforce/core';
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

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, val, i, arr) => {
    if (val.startsWith('--')) acc.push([val.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);

const orgAlias      = args['target-org'] ?? '';
const repoPath      = (args['repo-path'] ?? process.cwd()).replace(/[>]+$/, '').trim();
const doPromote     = args.promote === 'true';
const doMergeDeploy = args['merge-deploy'] === 'true';
const doFetchReady  = args['fetch-ready'] === 'true';
const fetchEnvType  = args['env-type'] ?? 'QA';

function parseApiName(filePath) {
  const parts = filePath.replace(/\\/g, '/').split('/');
  const defaultIdx = parts.indexOf('default');
  if (defaultIdx === -1) return null;
  const typeFolder = parts[defaultIdx + 1];
  if (['aura', 'lwc'].includes(typeFolder)) return parts[defaultIdx + 2] ?? null;
  return parts[parts.length - 1].replace(/-meta\.xml$/, '').replace(/\.[^.]+$/, '') || null;
}

async function main() {
  let conn;
  try {
    const authInfo = await AuthInfo.create({ username: orgAlias });
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
      emit({ type: 'fetch-done', stories: [], repoName: '' });
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

      let skipStory = false;
      try {
        const promRes = await conn.query(
          `SELECT copado__Promotion__r.copado__Status__c, copado__Promotion__r.LastModifiedDate ` +
          `FROM copado__Promoted_User_Story__c ` +
          `WHERE copado__User_Story__c = '${storyId}' ` +
          `ORDER BY copado__Promotion__r.LastModifiedDate DESC LIMIT 1`
        );
        const latestPromo = promRes.records[0];

        if (latestPromo?.copado__Promotion__r?.copado__Status__c === 'Completed with Errors') {
          const promoFailedDate = latestPromo.copado__Promotion__r.LastModifiedDate;
          // Only skip if we have a commit date AND it is NOT newer than the failure.
          // If latestCommitDate is null (field not populated) we can't tell → include the story.
          const developerFixed = !latestCommitDate || new Date(latestCommitDate) > new Date(promoFailedDate);
          if (!developerFixed) {
            skipStory = true;
            try {
              await conn.sobject('copado__User_Story__c').update({
                Id: storyId,
                copado__Ready_to_Promote__c: false,
              });
            } catch { /* non-fatal */ }
            emit({ type: 'fetch-unchecked', storyName, reason: 'Latest promotion failed with no new commits after failure' });
          }
        }
      } catch { /* non-fatal — include story if check fails */ }

      if (!skipStory) validStories.push({ id: storyId, name: storyName });
    }

    // Step 5: get git repo name from first valid story's project → pipeline → git repository
    let repoName = '';
    if (validStories.length > 0) {
      try {
        const storyRec = await conn.query(
          `SELECT copado__Project__r.copado__Deployment_Flow__r.copado__Git_Repository__r.Name ` +
          `FROM copado__User_Story__c WHERE Id = '${validStories[0].id}'`
        );
        repoName = storyRec.records[0]
          ?.copado__Project__r
          ?.copado__Deployment_Flow__r
          ?.copado__Git_Repository__r
          ?.Name ?? '';
      } catch { /* non-fatal */ }
    }

    emit({ type: 'fetch-done', stories: validStories.map(s => s.name), repoName });
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
      `SELECT Id, Name, copado__Org_Credential__c, copado__Project__c, copado__Project__r.Name, copado__Status__c, copado__Pull_Requests_Approved__c, copado__Has_Apex_Code__c ` +
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

  const git = simpleGit(repoPath);
  emit({ type: 'git-fetch-start' });
  try { await git.fetch(['origin']); }
  catch (err) { emit({ type: 'fatal', message: `git fetch failed: ${String(err)}` }); return; }
  emit({ type: 'git-fetch-done' });

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

    // Fetch test records — only care about Failed/Error status
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
      emit({ type: 'story-verified', storyName: story.Name, storyId: story.Id,
             projectId: story.copado__Project__c,
             projectName: story.copado__Project__r?.Name ?? 'Unknown Project',
             credentialId: story.copado__Org_Credential__c,
             branch: branchName, extraCommits: [], copadoCommits, unregistered: [],
             unregisteredDetail: [], storyCommittedBy: [...storyAuthorNames],
             extraCommittedBy: [], tests: storyTests,
             prApproved: story.copado__Pull_Requests_Approved__c, hasMetadata: storyMetadataNames.size > 0,
             hasApexCode: story.copado__Has_Apex_Code__c,
             verdict: 'error', message: `Remote branch ${remoteBranch} not found.` });
      continue;
    }

    const copadoSet    = new Set(copadoCommits);
    const unregistered = extraCommits.filter(h => !copadoSet.has(h));

    // Deep analysis of each unregistered commit
    const unregisteredDetail = [];
    for (const sha of unregistered) {
      let files = [];
      try {
        const raw = await git.raw(['diff-tree', '--no-commit-id', '-r', '--name-only', sha]);
        files = raw.split('\n').map(f => f.trim()).filter(Boolean);
      } catch { /* skip */ }

      let authorEmail = '', authorName = '';
      try {
        const log = await git.raw(['log', '--format=%ae|%an', '-1', sha]);
        [authorEmail, authorName] = log.trim().split('|');
      } catch { /* skip */ }

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

      unregisteredDetail.push({
        sha: sha.substring(0, 10), authorName, authorEmail, commitMessage,
        components, coveredComponents, uncoveredComponents, authorMismatch, copadoAuto,
      });
    }

    const extraCommittedBy = [...new Set(unregisteredDetail.map(d => d.authorName).filter(Boolean))];

    // Refined verdict — copado auto-commits (sourceApiVersion bumps) are always exempt
    const effectiveUnregistered = unregisteredDetail.filter(d => !d.copadoAuto);
    const allCovered    = effectiveUnregistered.length === 0 || effectiveUnregistered.every(d => d.uncoveredComponents.length === 0);
    const allSameAuthor = effectiveUnregistered.every(d => !d.authorMismatch);

    const verdict = extraCommits.length === 0        ? 'skip-no-commits'
      : unregistered.length === 0                    ? 'clean'
      : effectiveUnregistered.length === 0           ? 'clean'
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
      tests: storyTests,
      prApproved: story.copado__Pull_Requests_Approved__c, hasMetadata: storyMetadataNames.size > 0,
      hasApexCode: story.copado__Has_Apex_Code__c,
      verdict,
    });
  }

  emit({ type: 'done' });
}

main().catch(err => {
  emit({ type: 'fatal', message: String(err) });
  process.exit(1);
});
