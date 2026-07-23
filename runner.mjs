// Standalone runner — bypasses sf CLI framework entirely for fast startup
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, rmSync } from 'fs';
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

// Prevent git from blocking forever waiting for credentials on non-interactive machines.
// Without this, a git clone that needs auth will hang silently on a piped stdout.
process.env.GIT_TERMINAL_PROMPT = '0';

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
const fetchStatus         = args['fetch-status'] ?? '';
const fetchEnvs           = args['fetch-envs'] ?? '';
const fetchReadyToPromote = args['fetch-ready-to-promote'] !== 'false';
const fetchFiltersJson    = args['filters'] ?? '';
const doDescribeObject    = args['describe-object'] ?? '';

// Build a SOQL WHERE fragment from a dynamic filter state {logic, rows[{field, op, value}]}.
function buildFilterClause(filters) {
  if (!filters || !Array.isArray(filters.rows) || filters.rows.length === 0) return '';
  const logic = filters.logic === 'OR' ? ' OR ' : ' AND ';
  const safe = v => (v || '').replace(/'/g, "\\'");
  const fragments = [];
  for (const row of filters.rows) {
    const { field, op, value } = row;
    if (!field || !op) continue;
    const vals = (value || '').split(',').map(v => v.trim()).filter(Boolean);
    let frag = '';
    switch (op) {
      case 'equals': {
        const parts = (value || '').split(',').map(v => v.trim()).filter(Boolean);
        frag = parts.length > 1
          ? `${field} IN (${parts.map(v => `'${safe(v)}'`).join(',')})`
          : `${field} = '${safe(parts[0] ?? value)}'`;
        break;
      }
      case 'not_equal': {
        const parts = (value || '').split(',').map(v => v.trim()).filter(Boolean);
        frag = parts.length > 1
          ? `${field} NOT IN (${parts.map(v => `'${safe(v)}'`).join(',')})`
          : `${field} != '${safe(parts[0] ?? value)}'`;
        break;
      }
      case 'contains': {
        const parts = (value || '').split(',').map(v => v.trim()).filter(Boolean);
        frag = parts.length > 1
          ? `(${parts.map(v => `${field} LIKE '%${safe(v)}%'`).join(' OR ')})`
          : `${field} LIKE '%${safe(value)}%'`;
        break;
      }
      case 'not_contains': {
        const parts = (value || '').split(',').map(v => v.trim()).filter(Boolean);
        frag = parts.length > 1
          ? `(${parts.map(v => `(NOT ${field} LIKE '%${safe(v)}%')`).join(' AND ')})`
          : `(NOT ${field} LIKE '%${safe(value)}%')`;
        break;
      }
      case 'starts_with': {
        const parts = (value || '').split(',').map(v => v.trim()).filter(Boolean);
        frag = parts.length > 1
          ? `(${parts.map(v => `${field} LIKE '${safe(v)}%'`).join(' OR ')})`
          : `${field} LIKE '${safe(value)}%'`;
        break;
      }
      case 'in':           frag = vals.length ? `${field} IN (${vals.map(v => `'${safe(v)}'`).join(',')})` : ''; break;
      case 'not_in':       frag = vals.length ? `${field} NOT IN (${vals.map(v => `'${safe(v)}'`).join(',')})` : ''; break;
      case 'is_null':      frag = `${field} = null`; break;
      case 'not_null':     frag = `${field} != null`; break;
      case 'equals_true':  frag = `${field} = true`; break;
      case 'equals_false': frag = `${field} = false`; break;
      case 'gt':           frag = `${field} > ${parseFloat(value) || 0}`; break;
      case 'lt':           frag = `${field} < ${parseFloat(value) || 0}`; break;
      case 'gte':          frag = `${field} >= ${parseFloat(value) || 0}`; break;
      case 'lte':          frag = `${field} <= ${parseFloat(value) || 0}`; break;
    }
    if (frag) fragments.push(frag);
  }
  return fragments.length ? fragments.join(logic) : '';
}

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
  // Object-nested metadata: default/objects/<Object>/<subfolder>/<name>-meta.xml
  // Covers CustomField, RecordType, ValidationRule, FieldSet, WebLink, ListView, QuickAction.
  // Copado stores these as "Object.Name" — return the same format.
  if (typeFolder === 'objects' && parts.length >= defaultIdx + 5) {
    const objectName = parts[defaultIdx + 2];
    const memberName = parts[parts.length - 1].replace(/-meta\.xml$/, '').replace(/\.[^.]+$/, '');
    return memberName ? `${objectName}.${memberName}` : null;
  }
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
    emit({ type: 'instance-url', url: conn.instanceUrl });
  } catch (err) {
    emit({ type: 'fatal', message: `Auth failed for "${orgAlias}": ${String(err)}` });
    process.exit(1);
  }

  // ── DESCRIBE OBJECT MODE ────────────────────────────────────────────────────
  if (doDescribeObject) {
    try {
      const meta = await conn.describe(doDescribeObject);
      const NUM_TYPES = new Set(['int','double','currency','percent','long']);
      const fields = meta.fields
        .map(f => ({
          label: f.label,
          api:   f.name,
          type:  f.type === 'boolean' ? 'bool' : NUM_TYPES.has(f.type) ? 'num' : 'text',
        }))
        .sort((a, b) => a.label.localeCompare(b.label));
      emit({ type: 'fields', fields });
    } catch (err) {
      emit({ type: 'fields-error', message: String(err) });
    }
    process.exit(0);
  }

  // ── FETCH READY MODE ────────────────────────────────────────────────────────
  if (doFetchReady) {
    emit({ type: 'fetch-start', envType: fetchEnvType });

    // Build WHERE clause: prefer dynamic filter JSON; fall back to legacy static args.
    let whereClause = '';
    if (fetchFiltersJson) {
      try {
        const filters = JSON.parse(fetchFiltersJson);
        whereClause = buildFilterClause(filters);
      } catch { /* invalid JSON — fall through to legacy */ }
    }
    if (!whereClause) {
      // Legacy fallback for old cached webview HTML or direct CLI invocations.
      const effectiveStatus = fetchStatus || (fetchEnvType === 'UAT' ? 'Ready for UAT deployment' : 'Ready for QA deployment');
      const safeStatus = effectiveStatus.replace(/'/g, "\\'");
      const envList = fetchEnvs.split(',').map(e => e.trim()).filter(Boolean);
      const envClause = envList.length > 0
        ? ` AND copado__Org_Credential__r.Name IN (${envList.map(e => `'${e.replace(/'/g, "\\'")}'`).join(',')})`
        : '';
      const readyToPromoteClause = fetchReadyToPromote ? ` AND copado__Promote_Change__c = true` : '';
      whereClause = `copado__Status__c = '${safeStatus}'${readyToPromoteClause}${envClause}`;
    }
    const soql = `SELECT Id, Name FROM copado__User_Story__c WHERE ${whereClause} ORDER BY Name`;
    emit({ type: 'debug', message: `fetch filters: ${fetchFiltersJson ? 'dynamic' : 'legacy'}` });
    emit({ type: 'debug', message: `fetch SOQL: ${soql}` });

    let storyIds = [], storyNames = [];
    try {
      const res = await conn.query(soql);
      for (const r of (res.records ?? [])) {
        if (r.Id && r.Name) { storyIds.push(r.Id); storyNames.push(r.Name); }
      }
    } catch (err) {
      emit({ type: 'fatal', message: `Fetch query failed: ${String(err)}` });
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
        let retriggerDestEnvName = '—';
        try {
          const promoDetailRes = await conn.query(
            `SELECT copado__Destination_Environment__r.Name FROM copado__Promotion__c WHERE Id = '${pid}'`
          );
          retriggerDestEnvName = promoDetailRes.records[0]?.copado__Destination_Environment__r?.Name ?? '—';
        } catch { /* non-fatal — display '—' if query fails */ }
        emit({ type: 'promotion-retriggered', promotionId: pid, promotionName, projectId, storyCount: groupStories.length });
        promotionSummary.push({ success: true, projectId, destEnvName: retriggerDestEnvName, promotionName, promotionId: pid, storyCount: groupStories.length, stories: groupStories.map((name, i) => ({ name, developer: (group.storyDevelopers || [])[i] || '' })) });
        for (const name of groupStories) {
          emit({ type: 'promote-result', storyName: name, success: true, promotionId: pid });
        }
        mergeDeployQueue.push({ pid, deployOnly: group.deployOnly ?? false });
        continue;
      }

      let promotionId;
      try {
        let sourceEnvId, destEnvId, destEnvName, pipelineId;

        if (projectId === null) {
          // Env-grouped promote — look up pipeline step by source environment name directly.
          const sourceEnvName = group.sourceEnvName;
          if (!sourceEnvName) throw new Error('sourceEnvName missing for env-grouped promotion');
          const pcRes = await conn.query(
            `SELECT copado__Deployment_Flow__c, copado__Source_Environment__c, copado__Destination_Environment__c, copado__Destination_Environment__r.Name ` +
            `FROM copado__Deployment_Flow_Step__c ` +
            `WHERE copado__Source_Environment__r.Name = '${sourceEnvName}'`
          );
          if (pcRes.records.length === 0)
            throw new Error(`No pipeline step found for source environment '${sourceEnvName}'`);
          pipelineId  = pcRes.records[0].copado__Deployment_Flow__c ?? null;
          sourceEnvId = pcRes.records[0].copado__Source_Environment__c;
          destEnvId   = pcRes.records[0].copado__Destination_Environment__c;
          if (!destEnvId) throw new Error('Pipeline step has no destination environment');
          destEnvName = pcRes.records[0]?.copado__Destination_Environment__r?.Name ?? 'Unknown';
        } else {
          // Standard project-based promote
          // Step 1: Get deployment flow from project
          const projRes = await conn.query(
            `SELECT copado__Deployment_Flow__c FROM copado__Project__c WHERE Id = '${projectId}'`
          );
          pipelineId = projRes.records[0]?.copado__Deployment_Flow__c ?? null;
          if (!pipelineId) throw new Error(`No deployment flow found on project ${projectId}`);

          // Step 2: Get source environment ID from org credential
          // Use copado__Environment__c (env ID) not Name — org credential name != environment name
          const credRes = await conn.query(
            `SELECT Name, copado__Environment__c FROM copado__Org__c WHERE Id = '${credentialId}'`
          );
          if (!credRes.records[0]) throw new Error(`Org ${credentialId} not found`);
          const srcCredName = credRes.records[0].Name;
          const srcEnvId = credRes.records[0].copado__Environment__c;
          if (!srcEnvId) throw new Error(`Org credential ${srcCredName} has no linked environment`);

          // Step 3: Find deployment flow step by environment ID (avoids name mismatch)
          const pcRes = await conn.query(
            `SELECT copado__Source_Environment__c, copado__Destination_Environment__c, copado__Destination_Environment__r.Name ` +
            `FROM copado__Deployment_Flow_Step__c ` +
            `WHERE copado__Deployment_Flow__c = '${pipelineId}' ` +
            `AND copado__Source_Environment__c = '${srcEnvId}'`
          );
          if (pcRes.records.length === 0)
            throw new Error(`No pipeline step found for source '${srcCredName}' (env ${srcEnvId}) in deployment flow ${pipelineId}`);
          sourceEnvId = pcRes.records[0].copado__Source_Environment__c;
          destEnvId   = pcRes.records[0].copado__Destination_Environment__c;
          if (!destEnvId) throw new Error('Pipeline step has no destination environment');
          destEnvName = pcRes.records[0]?.copado__Destination_Environment__r?.Name ?? 'Unknown';
        }

        // Resolve destination org credential from copado__Org__c by environment
        const destOrgRes = await conn.query(
          `SELECT Id FROM copado__Org__c WHERE copado__Environment__c = '${destEnvId}' LIMIT 1`
        );
        if (destOrgRes.records.length === 0)
          throw new Error(`No org credential found for destination environment ${destEnvId}`);
        const destCredId = destOrgRes.records[0].Id;
        emit({ type: 'debug', message: `Destination credential resolved from env: ${destCredId}` });

        // For env-based promotes (INT→QA), the story's copado__Org_Credential__c is the developer's
        // DEV sandbox credential — not the INT env credential. Resolve source credential from env too.
        let sourceCredId = credentialId; // fallback: use story credential (correct for project-based promotes)
        if (projectId === null) {
          const srcOrgRes = await conn.query(
            `SELECT Id FROM copado__Org__c WHERE copado__Environment__c = '${sourceEnvId}' LIMIT 1`
          );
          if (srcOrgRes.records.length > 0) {
            sourceCredId = srcOrgRes.records[0].Id;
            emit({ type: 'debug', message: `Source credential resolved from env: ${sourceCredId}` });
          } else {
            emit({ type: 'debug', message: `No org for source env — falling back to story credential: ${credentialId}` });
          }
        }

        // Create promotion — omit copado__Project__c when null (leaves field blank on Salesforce record)
        const promoFields = {
          copado__Source_Org_Credential__c: sourceCredId,
          copado__Source_Environment__c: sourceEnvId,
          copado__Destination_Org_Credential__c: destCredId,
          copado__Destination_Environment__c: destEnvId,
          copado__Status__c: 'Draft',
        };
        // Copado does not allow Pipeline + Project together on a promotion.
        // If the story has a project, use Project (pipeline is inferred).
        // If no project, use Pipeline to group cross-project stories.
        if (projectId !== null) {
          promoFields.copado__Project__c = projectId;
        } else if (pipelineId) {
          promoFields.copado__Pipeline__c = pipelineId;
        }
        emit({ type: 'debug', message: `Creating promotion: ${JSON.stringify(promoFields)}` });
        let result;
        try {
          result = await conn.sobject('copado__Promotion__c').create(promoFields);
        } catch (createErr) {
          const msg = createErr.message || JSON.stringify(createErr);
          emit({ type: 'debug', message: `Create threw: ${msg}` });
          throw new Error(msg);
        }
        emit({ type: 'debug', message: `Create result: ${JSON.stringify(result)}` });
        if (!result.success) {
          const errMsg = (result.errors ?? [])
            .map(e => e.message || e.statusCode || JSON.stringify(e))
            .join('; ') || 'Create failed (no error detail)';
          emit({ type: 'debug', message: `Create failed: ${errMsg}` });
          throw new Error(errMsg);
        }
        promotionId = result.id;

        // Fetch the auto-generated promotion name (e.g. P26926)
        const nameRes = await conn.query(`SELECT Name FROM copado__Promotion__c WHERE Id = '${promotionId}'`);
        const promotionName = nameRes.records[0]?.Name ?? promotionId;

        emit({ type: 'promotion-created', promotionId, promotionName, projectId, storyCount: storyIds.length });
        promotionSummary.push({ success: true, projectId, destEnvName, promotionName, promotionId, storyCount: storyIds.length, stories: groupStories.map((name, i) => ({ name, developer: (group.storyDevelopers || [])[i] || '' })) });
      } catch (err) {
        emit({ type: 'debug', message: `Group create error (${groupStories.join(', ')}): ${String(err)}` });
        promotionSummary.push({ success: false, projectId, promotionId: null, storyCount: groupStories.length, stories: groupStories.map((name, i) => ({ name, developer: (group.storyDevelopers || [])[i] || '' })) });
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
      if (doMergeDeploy) mergeDeployQueue.push({ pid: promotionId, deployOnly: false });
    }

    // Step 5: Sequential PromoteAction calls — one per promotion with a delay between each.
    // Bulk inputs (>1) → Copado rejects all with "Only 1 request is available".
    // Immediate sequential calls → Copado silently drops subsequent ones while first job initialises.
    // Solution: one call at a time, 5-second gap to let Copado register the previous job.
    if (doMergeDeploy && mergeDeployQueue.length > 0) {
      const mergeCount   = mergeDeployQueue.filter(q => !q.deployOnly).length;
      const deployCount  = mergeDeployQueue.filter(q =>  q.deployOnly).length;
      const phaseLabel   = [
        mergeCount  > 0 ? `Triggering Merge & Deploy for ${mergeCount} promotion${mergeCount > 1 ? 's' : ''}` : '',
        deployCount > 0 ? `Triggering Deploy Changes for ${deployCount} validated promotion${deployCount > 1 ? 's' : ''}` : '',
      ].filter(Boolean).join(' | ');
      emit({ type: 'promote-phase', label: phaseLabel });
      for (let i = 0; i < mergeDeployQueue.length; i++) {
        const { pid, deployOnly } = mergeDeployQueue[i];
        if (i > 0) await new Promise(r => setTimeout(r, 5000));
        try {
          // Validated promotions: use PromotionDeployAction (Deploy Changes only — skip re-merge).
          // Regular promotions: use PromoteAction (Merge & Deploy).
          const actionUrl = deployOnly
            ? `/services/data/v${conn.version}/actions/custom/apex/copado__PromotionDeployAction`
            : `/services/data/v${conn.version}/actions/custom/apex/copado__PromoteAction`;
          const actionBody = deployOnly
            ? JSON.stringify({ inputs: [{ promotionId: pid }] })
            : JSON.stringify({ inputs: [{ promotionId: pid, executePromotion: true, executeDeployment: true }] });
          const actionRes = await conn.request({
            method: 'POST',
            url: actionUrl,
            headers: { 'Content-Type': 'application/json' },
            body: actionBody,
          });
          emit({ type: 'debug', message: `${deployOnly ? 'PromotionDeployAction' : 'PromoteAction'} [${pid}]: ${JSON.stringify(actionRes)}` });
          const result0 = actionRes?.[0];
          if (!result0?.isSuccess) {
            const errMsg = (result0?.errors || [])
              .map(e => e.message || e.statusCode || JSON.stringify(e)).join('; ')
              || 'PromoteAction returned isSuccess=false';
            emit({ type: 'merge-deploy-error', promotionId: pid, error: errMsg });
          } else {
            const jobExecId = result0?.outputValues?.jobExecution?.Id ?? null;
            emit({ type: 'merge-deploy-started', promotionId: pid, jobExecutionId: jobExecId, deployOnly });

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

  // Query Promoter_Config__mdt for custom fields to display on story cards.
  // Silently skipped if the MDT doesn't exist in the org.
  let customFieldConfigs = []; // [{ apiName, label, order }]
  try {
    const mdtRes = await conn.query(
      `SELECT Field_API_Name__c, Label__c, Order__c FROM Promoter_Config__mdt ORDER BY Order__c ASC NULLS LAST`
    );
    customFieldConfigs = (mdtRes.records ?? [])
      .filter(r => r.Field_API_Name__c)
      .map(r => ({ apiName: r.Field_API_Name__c.trim(), label: r.Label__c?.trim() || r.Field_API_Name__c.trim(), order: r.Order__c ?? 999 }));
    if (customFieldConfigs.length > 0) {
      emit({ type: 'custom-fields-config', fields: customFieldConfigs });
    }
  } catch { /* MDT not deployed — skip silently */ }

  const nameList = storyNames.map(n => `'${n}'`).join(',');
  const customFieldApiNames = customFieldConfigs.map(f => f.apiName);
  const customFieldSelect   = customFieldApiNames.length > 0 ? ', ' + customFieldApiNames.join(', ') : '';
  let stories = [];
  try {
    const result = await conn.query(
      `SELECT Id, Name, copado__Org_Credential__c, copado__Org_Credential__r.Name, copado__Environment__c, copado__Environment__r.Name, copado__Latest_Commit_Date__c, copado__Project__c, copado__Project__r.Name, copado__Status__c, copado__Pull_Requests_Approved__c, copado__Has_Apex_Code__c, copado__Developer__r.Name, copado__Base_Branch__c${customFieldSelect} ` +
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
    if (repoUri) emit({ type: 'git-repo-url', url: toHttpsUrl(repoUri).replace(/\.git$/, '') });
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

    // Validate the repo is actually functional — .git folder may exist but be corrupt/cleaned by OS temp purge
    let repoValid = false;
    if (existsSync(pathJoin(effectiveRepoPath, '.git'))) {
      try {
        await simpleGit(effectiveRepoPath).revparse(['--git-dir']);
        repoValid = true;
      } catch { /* .git folder exists but repo is corrupt — will wipe and re-clone */ }
    }

    if (repoValid) {
      // Repo is healthy — just fetch latest
      emit({ type: 'effective-repo-path', repoPath: effectiveRepoPath });
      emit({ type: 'git-fetch-start' });
      const g = simpleGit(effectiveRepoPath);
      try { await g.fetch(['--prune', 'origin']); }
      catch (err) { emit({ type: 'fatal', message: `git fetch failed: ${String(err)}` }); return; }
      emit({ type: 'git-fetch-done' });
      alreadyFetched = true;
    } else {
      // First time OR temp was purged/corrupted — wipe any leftover and re-clone
      if (existsSync(effectiveRepoPath)) {
        rmSync(effectiveRepoPath, { recursive: true, force: true });
      }
      emit({ type: 'git-clone-start', repoName: detectedRepoName });
      mkdirSync(tempBase, { recursive: true });
      try {
        await simpleGit({
          progress({ method, stage, progress }) {
            emit({ type: 'git-clone-progress', stage, percent: Math.round(progress) });
          },
        }).clone(toHttpsUrl(repoUri), effectiveRepoPath, ['--no-checkout']);
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
    try { await git.fetch(['--prune', 'origin']); }
    catch (err) { emit({ type: 'fatal', message: `git fetch failed: ${String(err)}` }); return; }
    emit({ type: 'git-fetch-done' });
  }

  // Build a pipeline level map across ALL deployment flow steps in the org.
  // Querying without a pipeline filter covers stories from multiple projects that
  // may belong to different pipelines (e.g. RBKDEV1 pipeline vs RBKMSPDEV pipeline).
  // Example: TRNDEV1(0) → TRNQA(1) → TRNUAT(2) → TRNPROD(3)
  const credLevel = new Map(); // envName (lowercase) → numeric level
  let pipelineEdges = []; // { from, to, fromId, toId }[]
  const pipelineEnvIdToName = new Map(); // envId → original-case env name
  try {
    const pipelineFilter = detectedPipelineId
      ? ` WHERE copado__Deployment_Flow__c = '${detectedPipelineId}'`
      : '';
    const stepsRes = await conn.query(
      `SELECT copado__Source_Environment__c, copado__Source_Environment__r.Name, ` +
      `copado__Destination_Environment__c, copado__Destination_Environment__r.Name ` +
      `FROM copado__Deployment_Flow_Step__c${pipelineFilter}`
    );
    for (const s of stepsRes.records) {
      if (s.copado__Source_Environment__c && s.copado__Source_Environment__r?.Name)
        pipelineEnvIdToName.set(s.copado__Source_Environment__c, s.copado__Source_Environment__r.Name);
      if (s.copado__Destination_Environment__c && s.copado__Destination_Environment__r?.Name)
        pipelineEnvIdToName.set(s.copado__Destination_Environment__c, s.copado__Destination_Environment__r.Name);
    }
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
    const pipelineOrderedEnvs = [...credLevel.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([name]) => name);
    emit({ type: 'pipeline-info', envOrder: pipelineOrderedEnvs });
  } catch (pipelineErr) { emit({ type: 'debug', message: `pipeline ERROR: ${pipelineErr}` }); }

  // Resolve credential IDs → env name using pipelineEnvIdToName.
  // Queries copado__Org__c by primary key (Id) — always indexed/fast.
  // Called once per dep batch, not per-story.
  async function resolveCredIdsToEnvNames(credIds) {
    const result = new Map(); // credId → original-case env name
    if (!credIds.length) return result;
    try {
      const idList = [...new Set(credIds)].map(id => `'${id}'`).join(', ');
      const res = await conn.query(`SELECT Id, copado__Environment__c FROM copado__Org__c WHERE Id IN (${idList})`);
      emit({ type: 'debug', message: `resolveCredIds: queried ${credIds.length} cred(s), got ${res.records.length} org records: ${res.records.map(r => `${r.Id}→envId:${r.copado__Environment__c ?? 'NULL'}`).join(', ')} | pipelineEnvIdToName size=${pipelineEnvIdToName.size}` });
      for (const r of res.records) {
        const envName = pipelineEnvIdToName.get(r.copado__Environment__c);
        if (envName) result.set(r.Id, envName);
      }
    } catch (e) { emit({ type: 'debug', message: `resolveCredIds error: ${e.message}` }); }
    return result;
  }

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

    // Fetch non-Complete commit records for this story (sha → Copado status).
    // 'Failed' commits get the same coverage check as regular unregistered commits.
    // All other non-Complete statuses (e.g. 'Commit not in branch') always block.
    let nonCompleteCommitShas = new Map(); // sha → copadoStatus
    try {
      const ncRes = await conn.query(
        `SELECT copado__Snapshot_Commit__r.copado__Commit_Id__c, copado__Status__c FROM copado__User_Story_Commit__c ` +
        `WHERE copado__User_Story__c = '${story.Id}' AND copado__Status__c != 'Complete'`
      );
      for (const r of ncRes.records) {
        const sha = r.copado__Snapshot_Commit__r?.copado__Commit_Id__c?.trim().toLowerCase();
        const status = r.copado__Status__c ?? 'Unknown';
        if (sha) nonCompleteCommitShas.set(sha, status);
      }
      if (nonCompleteCommitShas.size > 0)
        emit({ type: 'debug', message: `${story.Name}: ${nonCompleteCommitShas.size} non-Complete commit SHA(s) found` });
    } catch { /* non-fatal */ }

    // Fetch story metadata component names (for coverage check) and detect 'xml' type records
    let storyMetadataNames = new Set();
    let xmlTypeMetadata = []; // file names whose Type = 'xml' — causes deployment registry errors
    let hasApexMetadata = false; // true if any USM record has an Apex type (ApexClass, ApexTrigger, ApexPage, etc.)
    try {
      const metaResult = await conn.query(
        `SELECT copado__Metadata_API_Name__c, copado__Type__c FROM copado__User_Story_Metadata__c ` +
        `WHERE copado__User_Story__c = '${story.Id}'`
      );
      storyMetadataNames = new Set(
        metaResult.records.map(r => r.copado__Metadata_API_Name__c?.toLowerCase()).filter(Boolean)
      );
      xmlTypeMetadata = metaResult.records
        .filter(r => (r.copado__Type__c ?? '').toLowerCase() === 'xml')
        .map(r => r.copado__Metadata_API_Name__c ?? 'Unknown');
      if (xmlTypeMetadata.length > 0)
        emit({ type: 'debug', message: `${story.Name}: ${xmlTypeMetadata.length} metadata record(s) with Type=xml — will block promotion: ${xmlTypeMetadata.join(', ')}` });
      hasApexMetadata = metaResult.records.some(r => /^apex/i.test(r.copado__Type__c ?? ''));
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

    // Get all commits on feature branch ahead of the story's base branch (falls back to master).
    const storyBaseBranch = (story.copado__Base_Branch__c ?? '').trim();
    const diffBase        = storyBaseBranch ? `origin/${storyBaseBranch}` : 'origin/master';
    let extraCommits = [];
    try {
      const raw = await git.raw(['log', '--format=%H', `${diffBase}..${remoteBranch}`]);
      extraCommits = raw.split('\n').map(h => h.trim()).filter(Boolean);
    } catch {
      if (diffBase !== 'origin/master') {
        // Base branch may not exist on remote — fall back to master
        try {
          const raw = await git.raw(['log', '--format=%H', `origin/master..${remoteBranch}`]);
          extraCommits = raw.split('\n').map(h => h.trim()).filter(Boolean);
          emit({ type: 'debug', message: `${story.Name}: base branch '${storyBaseBranch}' not on remote, fell back to master` });
        } catch { /* handled below */ }
      }
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
               srcEnvName: story.copado__Environment__r?.Name ?? story.copado__Org_Credential__r?.Name ?? null,
               dstEnvName: (() => { const s = story.copado__Environment__r?.Name ?? story.copado__Org_Credential__r?.Name ?? null; return s ? (pipelineEdges.find(e => e.from === s.toLowerCase())?.to ?? null) : null; })(),
               customFields: customFieldConfigs.map(f => ({ label: f.label, value: story[f.apiName] ?? null })),
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
      // Exact match covers most types. Prefix match (e.g. "Account" → "Account.MyRule")
      // covers SharingCriteriaRule, SharingOwnerRule, WorkflowRule — stored as one file
      // per object in git but tracked individually (Object.Name) in Copado metadata.
      const isCovered = (c) => {
        const cl = c.toLowerCase();
        return storyMetadataNames.has(cl) || [...storyMetadataNames].some(m => m.startsWith(cl + '.'));
      };
      const coveredComponents   = components.filter(c => isCovered(c));
      const uncoveredComponents = components.filter(c => !isCovered(c));
      const authorMismatch      = authorEmail ? !storyAuthorEmails.has(authorEmail.toLowerCase()) : false;

      // Check if this unregistered SHA matches a Copado commit record with non-Complete status.
      // Copado may store abbreviated SHAs — compare both directions.
      const shaLower = sha.toLowerCase();
      let copadoStatus = null;
      for (const [nc, status] of nonCompleteCommitShas) {
        if (shaLower.startsWith(nc) || nc.startsWith(shaLower)) {
          copadoStatus = status;
          break;
        }
      }

      unregisteredDetail.push({
        sha: sha.substring(0, 10), authorName, authorEmail, committerName, isAmended, commitMessage,
        components, coveredComponents, uncoveredComponents, authorMismatch, copadoAuto, copadoStatus,
      });
    }

    const extraCommittedBy = [...new Set(unregisteredDetail.map(d => d.authorName).filter(Boolean))];

    // Check if this story's Base Branch points to another story's feature branch.
    // If yes, that parent story must be in a higher environment before this one deploys.
    // Source: copado__Base_Branch__c field (e.g. "feature/US-0004674") — no git needed.
    let parentStory = null; // { name: string, promoted: boolean } | null
    try {
      const baseBranch  = story.copado__Base_Branch__c ?? '';
      const parentMatch = baseBranch.match(/US-\d+/);
      if (parentMatch) {
        const parentName = parentMatch[0];
        const parentRes = await conn.query(
          `SELECT copado__Org_Credential__c, copado__Org_Credential__r.Name, copado__Environment__r.Name FROM copado__User_Story__c WHERE Name = '${parentName}' LIMIT 1`
        );
        const parentCredId    = parentRes.records[0]?.copado__Org_Credential__c ?? null;
        const parentCredName  = parentRes.records[0]?.copado__Org_Credential__r?.Name ?? null;
        const credIdMap       = await resolveCredIdsToEnvNames(parentCredId ? [parentCredId] : []);
        const parentEnvName   = parentRes.records[0]?.copado__Environment__r?.Name
                             ?? (parentCredId ? credIdMap.get(parentCredId) : null)
                             ?? null;
        const currentCredName = story.copado__Org_Credential__r?.Name ?? null;
        const currentLevel = credLevel.get(srcEnvName?.toLowerCase() ?? '') ?? -1;
        const parentLevel  = credLevel.get(parentEnvName?.toLowerCase() ?? '') ?? -1;

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
        parentStory = { name: parentName, promoted: parentPromoted, env: parentEnvName ?? dstEnvName?.toUpperCase() ?? parentCredName, credential: parentCredName };
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
    const srcEnvName = story.copado__Environment__r?.Name ?? story.copado__Org_Credential__r?.Name ?? null;
    const dstEnvName = srcEnvName
      ? (pipelineEdges.find(e => e.from === srcEnvName.toLowerCase())?.to ?? null)
      : null;
    emit({ type: 'debug', message: `env ${story.Name}: envName=${srcEnvName} → dst=${dstEnvName ?? 'NOT FOUND'}` });

    // Check if the story's latest promotion (same source+target) is in a warning state.
    let lastPromoWarning = null; // { status, name, id } | null
    let stalePromoInfo = null;   // { status, name } — last promo was a failure but a fix commit was made after
    try {
      const latestCommitDate = story.copado__Latest_Commit_Date__c ?? null;
      // Fetch the single most recent promotion this story is in (no SOQL env filter to avoid
      // silent mismatches from manually-added stories). Validate source+target in JS.
      const soql =
        `SELECT Id, Name, copado__Status__c, CreatedDate, LastModifiedDate, ` +
        `copado__Source_Org_Credential__r.Name, copado__Destination_Environment__r.Name ` +
        `FROM copado__Promotion__c ` +
        `WHERE Id IN (SELECT copado__Promotion__c FROM copado__Promoted_User_Story__c WHERE copado__User_Story__c = '${story.Id}') ` +
        `ORDER BY CreatedDate DESC LIMIT 1`;
      const promoRes = await conn.query(soql);
      const latest = promoRes.records[0] ?? null;
      const storySrc = (story.copado__Environment__r?.Name ?? story.copado__Org_Credential__r?.Name ?? '').toLowerCase();
      const storyDst = dstEnvName?.toLowerCase() ?? '';
      const promoSrc = (latest?.copado__Source_Org_Credential__r?.Name ?? '').toLowerCase();
      const promoDst = (latest?.copado__Destination_Environment__r?.Name ?? '').toLowerCase();
      // Source credential is intentionally not checked: a promotion can contain stories from multiple
      // developer sandboxes (DEV1, DEV2, ...) but the promotion records only one source credential.
      // Matching on source would reject legitimate multi-developer promotions.
      // Only the destination is used to confirm the promotion is on the correct pipeline path.
      const srcMatch = !storySrc || !promoSrc || promoSrc === storySrc; // kept for debug log only
      const dstMatch = !storyDst || !promoDst || promoDst === storyDst;
      const promo = (latest && dstMatch) ? latest : null;
      emit({ type: 'debug', message: `promo ${story.Name}: last promo ${latest?.Name ?? 'none'} src:${promoSrc}→${storySrc}(${srcMatch?'ok':'MISMATCH'}) dst:${promoDst}→${storyDst}(${dstMatch?'ok':'MISMATCH'})` });
      emit({ type: 'debug', message: `promo ${story.Name}: latest = ${promo ? `${promo.Name} | status=${promo.copado__Status__c} | created=${promo.CreatedDate}` : 'none'}` });
      const promoStatus = promo?.copado__Status__c;
      // Always check for a live (Queued or In Progress) SFDX JE — irrespective of promotion status.
      // A live JE is the authoritative current state and takes priority over copado__Status__c.
      let liveJe = null;
      if (promo) {
        try {
          // SFDX Promote JE: links via copado__Promotion__c (direct lookup to Promotion).
          // SFDX Deploy JE:  links via copado__Deployment__c → Deployment object → copado__Promotion__c.
          //                  i.e. copado__Deployment__r.copado__Promotion__c = promo.Id
          // Check Deploy first (created after Promote completes); fall back to Promote if Deploy not yet created.
          let deployJe = null;
          try {
            const deployRes = await conn.query(
              `SELECT Id, Name, copado__Status__c, CreatedDate, copado__Template__r.Name FROM copado__JobExecution__c ` +
              `WHERE copado__Deployment__r.copado__Promotion__c = '${promo.Id}' ` +
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
          stalePromoInfo = { status: promoStatus, name: promo.Name };
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

          let mcSiblingStories = [];
          try {
            const mcSibRes = await conn.query(
              `SELECT copado__User_Story__r.Name, copado__User_Story__r.copado__Org_Credential__r.Name, ` +
              `copado__User_Story__r.copado__Developer__r.Name ` +
              `FROM copado__Promoted_User_Story__c WHERE copado__Promotion__c = '${promo.Id}'`
            );
            mcSiblingStories = mcSibRes.records
              .map(r => ({
                name:       r.copado__User_Story__r?.Name,
                env:        srcEnvName,
                credential: r.copado__User_Story__r?.copado__Org_Credential__r?.Name ?? null,
                developer:  r.copado__User_Story__r?.copado__Developer__r?.Name ?? null,
              }))
              .filter(s => s.name)
              .filter(s => s.name.toUpperCase() !== story.Name.toUpperCase());
          } catch (e) {
            emit({ type: 'debug', message: `conflict ${story.Name}: sibling fetch error: ${e.message}` });
          }
          // Check if developer resolved conflicts for this story (RESOLVED attachment exists on promotion)
          let hasResolutionFiles = false;
          try {
            const attRes = await conn.query(
              `SELECT COUNT() FROM Attachment WHERE ParentId = '${promo.Id}' AND Name LIKE 'RESOLVED%${story.Name}%'`
            );
            hasResolutionFiles = (attRes.totalSize ?? 0) > 0;
          } catch (attErr) {
            emit({ type: 'debug', message: `resolution att query error ${story.Name}: ${attErr}` });
          }
          lastPromoWarning = { status: promoStatus, name: promo.Name, id: promo.Id, conflictCulprit, isConflictOnCurrentStory, mergedIntoPromotion, siblingStories: mcSiblingStories, hasResolutionFiles };

        } else {
          // 'Completed with errors' or 'Conflicts Resolved'
          const storyCountRes = await conn.query(
            `SELECT COUNT() FROM copado__Promoted_User_Story__c WHERE copado__Promotion__c = '${promo.Id}'`
          );
          const storyCount = storyCountRes.totalSize ?? 0;
          emit({ type: 'debug', message: `promo ${story.Name}: story count in ${promo.Name} = ${storyCount}` });

          if (promoStatus === 'Completed with errors' || promoStatus === 'Validation failed') {
            // Fetch siblings so the UI can list who else was in this failed promotion.
            let siblingStories = [];
            if (storyCount > 1) {
              try {
                const sibRes = await conn.query(
                  `SELECT copado__User_Story__r.Name, copado__User_Story__r.copado__Org_Credential__r.Name, ` +
                  `copado__User_Story__r.copado__Environment__r.Name, ` +
                  `copado__User_Story__r.copado__Developer__r.Name ` +
                  `FROM copado__Promoted_User_Story__c WHERE copado__Promotion__c = '${promo.Id}'`
                );
                siblingStories = sibRes.records
                  .map(r => ({
                    name:       r.copado__User_Story__r?.Name,
                    env:        srcEnvName,
                    credential: r.copado__User_Story__r?.copado__Org_Credential__r?.Name ?? null,
                    developer:  r.copado__User_Story__r?.copado__Developer__r?.Name ?? null,
                  }))
                  .filter(s => s.name)
                  .filter(s => s.name.toUpperCase() !== story.Name.toUpperCase());
              } catch (e) {
                emit({ type: 'debug', message: `promo ${story.Name}: sibling fetch error: ${e.message}` });
              }
            }
            lastPromoWarning = { status: promoStatus, name: promo.Name, id: promo.Id, siblingStories };

          } else if (promoStatus === 'Conflicts Resolved' || promoStatus === 'Validated') {
            // Multi-story Conflicts Resolved — emit sibling story names so the UI can decide
            // whether all siblings are present in the current verify list (safe to re-trigger together)
            // or some are missing (fall back to separate new promotion).
            const sibRes = await conn.query(
              `SELECT copado__User_Story__r.Name, copado__User_Story__r.copado__Org_Credential__r.Name, ` +
              `copado__User_Story__r.copado__Developer__r.Name ` +
              `FROM copado__Promoted_User_Story__c ` +
              `WHERE copado__Promotion__c = '${promo.Id}'`
            );
            const siblingStories = sibRes.records
              .map(r => ({
                name:       r.copado__User_Story__r?.Name,
                env:        srcEnvName,
                credential: r.copado__User_Story__r?.copado__Org_Credential__r?.Name ?? null,
                developer:  r.copado__User_Story__r?.copado__Developer__r?.Name ?? null,
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
    // 'Failed' commits are checked via coverage (same as regular unregistered commits).
    // Any other non-Complete status (e.g. 'Commit not in branch') always blocks.
    const hasHardBlock = unregisteredDetail.some(d => d.copadoStatus && d.copadoStatus !== 'Failed');

    const verdict = extraCommits.length === 0        ? 'skip-no-commits'
      : unregistered.length === 0                    ? 'clean'
      : effectiveUnregistered.length === 0           ? 'clean'
      : hasHardBlock                                   ? 'skip-unregistered'
      : !allCovered                                  ? 'skip-unregistered'
      : !allSameAuthor                               ? 'skip-needs-verify'
      : 'skip-covered-same-author';

    // Query all dependency records where this story is the child.
    // credLevel (built from pipeline BFS) gives each env a numeric level so we can tell if a
    // parent is "ahead" (higher level = further along the pipeline = already promoted past child).
    let dependencies = [];
    try {
      const depRes = await conn.query(
        `SELECT Id, copado__Relationship_Type__c, copado__Provider_User_Story__c, ` +
        `copado__Provider_User_Story__r.Name, ` +
        `copado__Provider_User_Story__r.copado__Org_Credential__c, ` +
        `copado__Provider_User_Story__r.copado__Org_Credential__r.Name, ` +
        `copado__Provider_User_Story__r.copado__Environment__r.Name, ` +
        `copado__Provider_User_Story__r.copado__Developer__r.Name ` +
        `FROM copado__Team_Dependency__c ` +
        `WHERE copado__Dependent_User_Story__c = '${story.Id}'`
      );
      const childLevel   = credLevel.get(srcEnvName?.toLowerCase() ?? '') ?? -1;
      const siblingNames = new Set((lastPromoWarning?.siblingStories ?? []).map(s => (s.name ?? '').toUpperCase()));
      emit({ type: 'debug', message: `dep-check ${story.Name}: srcEnvName=${srcEnvName} siblingCount=${siblingNames.size} siblings=[${[...siblingNames].join(',')}]` });
      // Query provider story envs by credential ID (same as parentStory uses resolveCredIdsToEnvNames)
      const providerCredIds = [...new Set(depRes.records.map(r => r.copado__Provider_User_Story__r?.copado__Org_Credential__c).filter(Boolean))];
      const provCredToEnv   = providerCredIds.length > 0 ? await resolveCredIdsToEnvNames(providerCredIds) : new Map();
      emit({ type: 'debug', message: `dep-check ${story.Name}: srcEnvName=${srcEnvName} provCredToEnv=[${[...provCredToEnv.entries()].map(([k,v])=>`${k}→${v}`).join(', ')}]` });
      dependencies = depRes.records.map(r => {
        const parentName   = r.copado__Provider_User_Story__r?.Name ?? '';
        const inSamePromo  = siblingNames.has(parentName.toUpperCase());
        const parentCredId = r.copado__Provider_User_Story__r?.copado__Org_Credential__c ?? null;
        // Direct env from dep SOQL traversal; credential-resolved env from resolveCredIdsToEnvNames
        const directEnv    = r.copado__Provider_User_Story__r?.copado__Environment__r?.Name ?? null;
        const credEnv      = parentCredId ? (provCredToEnv.get(parentCredId) ?? null) : null;
        // Prefer pipeline-valid env names (same logic as parentStory lookup)
        const parentEnv    = inSamePromo
                           ? srcEnvName
                           : (credLevel.has((directEnv ?? '').toLowerCase()) ? directEnv
                              : credLevel.has((credEnv ?? '').toLowerCase())  ? credEnv
                              : directEnv ?? credEnv ?? r.copado__Provider_User_Story__r?.copado__Org_Credential__r?.Name ?? null);
        emit({ type: 'debug', message: `dep-resolve ${parentName}: inSamePromo=${inSamePromo} directEnv=${directEnv} credEnv=${credEnv} parentEnv=${parentEnv}` });
        const parentLevel = credLevel.get(parentEnv?.toLowerCase() ?? '') ?? -1;
        return {
          relationshipType:  r.copado__Relationship_Type__c ?? '',
          parentName,
          parentId:          r.copado__Provider_User_Story__c ?? '',
          parentEnv,
          parentDeveloper:   r.copado__Provider_User_Story__r?.copado__Developer__r?.Name ?? null,
          parentAhead:       parentLevel > childLevel,
          parentInSamePromo: inSamePromo,
          promoName:         lastPromoWarning?.name ?? null,
        };
      });
      emit({ type: 'debug', message: `${story.Name}: dep query (Id=${story.Id}): ${dependencies.length} dependenc${dependencies.length === 1 ? 'y' : 'ies'} found${dependencies.length > 0 ? ' | ' + dependencies.map(d => `${d.parentName}@${d.parentEnv}(ahead=${d.parentAhead})`).join(', ') : ''}` });
    } catch (depErr) {
      emit({ type: 'debug', message: `${story.Name}: dependency query error: ${depErr.message}` });
    }

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
      hasApexCode: story.copado__Has_Apex_Code__c, hasApexMetadata, hasDeploymentTasks,
      parentStory, promotionCount, lastPromoWarning, stalePromoInfo,
      latestCommitDate: story.copado__Latest_Commit_Date__c ?? null,
      latestUnregisteredCommitDate,
      srcEnvName, dstEnvName,
      baseBranch: (story.copado__Base_Branch__c ?? '').trim() || null,
      dependencies,
      xmlTypeMetadata,
      customFields: customFieldConfigs.map(f => ({ label: f.label, value: story[f.apiName] ?? null })),
      verdict,
    });
  }

  emit({ type: 'done' });
}

main().catch(err => {
  emit({ type: 'fatal', message: String(err) });
  process.exit(1);
});
