
const vscode = acquireVsCodeApi();

let cleanStories       = [];   // [{name, id, projectId, credentialId, skipped}]
let verifiedStoryNames = new Set(); // all story names that came back from verify (uppercased), for culprit-in-list check
let storyWarningMap    = new Map(); // upperName → lastPromoWarning | null, for sibling tag rendering
let currentOrg         = '';
let runCompleted       = false;
let inPromoteMode      = false;
let mergeDeployResults = [];   // [{success, promotionId, jobId?, error?}]
let isPartialReVerify  = false; // true when re-verifying only force-promote stories
let forcePromoStoryNames = new Set(); // ALL stories flagged as isFailedPromo (regardless of Force checkbox)


function updatePromoteCount() {
  const count = cleanStories.filter(s => !s.skipped).length;
  document.getElementById('cleanCount').textContent = count;
  updatePromoteList();
}

function updatePromoteList() {
  const el = document.getElementById('promoteList');
  if (!el) return;
  if (cleanStories.length === 0) { el.innerHTML = ''; return; }

  const allIncluded  = cleanStories.every(s => !s.skipped);
  const noneIncluded = cleanStories.every(s => s.skipped);

  // Group all eligible stories (including skipped) by project
  const groupOrder = [];
  const groups = {};
  for (const s of cleanStories) {
    if (!groups[s.projectId]) {
      groups[s.projectId] = { name: s.projectName || s.projectId, stories: [] };
      groupOrder.push(s.projectId);
    }
    groups[s.projectId].stories.push(s);
  }

  const headerHtml = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;padding:5px 8px;background:rgba(26,184,232,0.05);border-radius:5px;border:1px solid rgba(26,184,232,0.12)">
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none">
        <input type="checkbox" id="selectAllCb" ${allIncluded ? 'checked' : ''}
               style="width:14px;height:14px;accent-color:#1ab8e8;cursor:pointer;flex-shrink:0" />
        <span style="font-size:11px;font-weight:600;color:#7fc9e0">Select All</span>
      </label>
      <span style="font-size:10px;color:#334155;margin-left:4px">— uncheck to exclude from promotion</span>
    </div>`;

  const storiesHtml = groupOrder.map(pid => {
    const g = groups[pid];
    const rowsHtml = g.stories.map(s => {
      const included = !s.skipped;
      const nameCol  = included ? '#e2f4fb' : '#2a4455';
      const devCol   = included ? '#4a8aaa' : '#1e3448';
      const strike   = '';
      const rowBg    = included ? 'transparent' : 'rgba(0,0,0,0.15)';
      const dev      = s.developer ? `<span style="color:${devCol};font-size:10px;margin-left:5px">·  ${s.developer}</span>` : '';
      const sepActive = s.separate;
      const sepBtn   = `<button class="pl-sep-btn" data-story="${s.name}"
          style="margin-left:auto;padding:2px 8px;font-size:9px;font-weight:600;border-radius:3px;cursor:pointer;white-space:nowrap;outline:none;letter-spacing:0.3px;transition:all 0.15s;
                 border:1px solid ${sepActive ? '#1ab8e8' : '#1e3a4a'};
                 background:${sepActive ? 'rgba(26,184,232,0.18)' : 'transparent'};
                 color:${sepActive ? '#1ab8e8' : '#2a4a60'}">
          ⟶ Separate
        </button>`;
      return `<div style="display:flex;align-items:center;gap:0;padding:4px 6px;border-radius:4px;background:${rowBg};margin-bottom:1px">
        <input type="checkbox" class="pl-include-cb" data-story="${s.name}" ${included ? 'checked' : ''}
               style="width:13px;height:13px;accent-color:#1ab8e8;cursor:pointer;flex-shrink:0;margin-right:9px" />
        <span style="font-family:monospace;font-size:11px;font-weight:500;color:${nameCol};${strike}">${s.name}</span>
        ${s.forcePromo ? `<span style="font-size:9px;font-weight:700;color:#f59e0b;margin-left:4px;padding:1px 4px;border:1px solid rgba(245,158,11,0.4);border-radius:2px">⚠ FORCE</span>` : ''}
        ${dev}
        ${s.promoWarning ? `<span style="font-size:9px;color:#94a3b8;margin-left:8px;flex-shrink:0">In Promotion · ${s.promoWarning.name} · ${s.promoWarning.status}</span>` : ''}
        ${sepBtn}
      </div>`;
    }).join('');
    return `<div style="margin-bottom:10px">
      <div style="font-size:9px;font-weight:700;color:#1ab8e8;text-transform:uppercase;letter-spacing:0.9px;padding:3px 0 4px;border-bottom:1px solid rgba(26,184,232,0.15);margin-bottom:4px">${g.name}</div>
      ${rowsHtml}
    </div>`;
  }).join('');

  el.innerHTML = headerHtml + storiesHtml;

  // Show re-verify button only when there are force-promoted stories in the list
  document.getElementById('reVerifyForceWrap').style.display = forcePromoStoryNames.size > 0 ? 'block' : 'none';

  const selectAllCb = document.getElementById('selectAllCb');
  if (selectAllCb && !allIncluded && !noneIncluded) selectAllCb.indeterminate = true;

  // Select All / Deselect All
  selectAllCb?.addEventListener('change', () => {
    const include = selectAllCb.checked;
    for (const s of cleanStories) {
      s.skipped = !include;
      if (!include) s.separate = false;
    }
    for (const s of cleanStories) {
      const row = document.getElementById('row-' + s.name.replace(/[^a-z0-9]/gi, '_'));
      const skipCb = row?.querySelector(`.skip-story-cb[data-story="${s.name}"]`);
      const sepCb  = row?.querySelector(`.separate-promo-cb[data-story="${s.name}"]`);
      if (skipCb) skipCb.checked = !include;
      if (sepCb && !include) sepCb.checked = false;
    }
    updatePromoteCount();
  });

  // Per-story include checkbox
  el.querySelectorAll('.pl-include-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      const name = cb.dataset.story;
      const s = cleanStories.find(s => s.name === name);
      if (!s) return;
      s.skipped = !cb.checked;
      if (!cb.checked) s.separate = false;
      const row = document.getElementById('row-' + name.replace(/[^a-z0-9]/gi, '_'));
      const mainSkip = row?.querySelector(`.skip-story-cb[data-story="${name}"]`);
      const mainSep  = row?.querySelector(`.separate-promo-cb[data-story="${name}"]`);
      if (mainSkip) mainSkip.checked = !cb.checked;
      if (mainSep && !cb.checked) mainSep.checked = false;
      updatePromoteCount();
    });
  });

  // Per-story Separate Promo pill button
  el.querySelectorAll('.pl-sep-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.story;
      const s = cleanStories.find(s => s.name === name);
      if (!s) return;
      s.separate = !s.separate;
      if (s.separate && s.skipped) { s.skipped = false; }
      const row = document.getElementById('row-' + name.replace(/[^a-z0-9]/gi, '_'));
      const mainSep  = row?.querySelector(`.separate-promo-cb[data-story="${name}"]`);
      const mainSkip = row?.querySelector(`.skip-story-cb[data-story="${name}"]`);
      if (mainSep) mainSep.checked = s.separate;
      if (mainSkip && s.separate) mainSkip.checked = false;
      updatePromoteCount();
    });
  });
}


function reVerifyForceStories() {
  if (forcePromoStoryNames.size === 0) return;
  const orgAlias = document.getElementById('orgAlias').value.trim();
  const repoPath = document.getElementById('repoPath').value.trim();
  if (!orgAlias) return;

  // Remove any force stories that were manually checked from cleanStories — story-verified will re-evaluate them
  for (const name of forcePromoStoryNames) {
    const idx = cleanStories.findIndex(c => c.name === name && c.forcePromo);
    if (idx !== -1) cleanStories.splice(idx, 1);
  }
  updatePromoteCount();

  const count = forcePromoStoryNames.size;
  isPartialReVerify = true;
  document.getElementById('verifyBtn').disabled = true;
  document.getElementById('cancelBtn').style.display = 'inline-flex';
  setStatus('info', `Re-verifying ${count} force stor${count === 1 ? 'y' : 'ies'}...`, true);
  vscode.postMessage({ command: 'verify', stories: [...forcePromoStoryNames].join(','), orgAlias, repoPath });
}

// ── Project grouping state ─────────────────────────────────────────────────
let projectHeaderMap = {};   // { [projectId]: <tr> header element }
let projectLastRow   = {};   // { [projectId]: last <tr> element in this project section }

const MAX_HISTORY = 5;
function loadHistory(key) {
  try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; }
}
function saveHistory(key, value) {
  if (!value) return;
  const list = [value, ...loadHistory(key).filter(v => v !== value)].slice(0, MAX_HISTORY);
  localStorage.setItem(key, JSON.stringify(list));
}
function populateDatalist(id, key) {
  const dl = document.getElementById(id);
  dl.innerHTML = '';
  loadHistory(key).forEach(v => { const o = document.createElement('option'); o.value = v; dl.appendChild(o); });
}

// Seed localStorage from globalState-persisted history so aliases survive panel close/reopen.
if (Array.isArray(window.__orgHistory) && window.__orgHistory.length > 0) {
  const existing = loadHistory('orgAliasHistory');
  const merged = [...new Set([...window.__orgHistory, ...existing])].slice(0, MAX_HISTORY);
  localStorage.setItem('orgAliasHistory', JSON.stringify(merged));
}

populateDatalist('orgAliasList', 'orgAliasHistory');
populateDatalist('repoPathList', 'repoPathHistory');

// Apply defaults injected by panel.ts at HTML generation time.
// Only overwrite if the field is still empty (don't clobber user input).
if (window.__defaultOrg && !document.getElementById('orgAlias').value) {
  document.getElementById('orgAlias').value = window.__defaultOrg;
  saveHistory('orgAliasHistory', window.__defaultOrg);
  populateDatalist('orgAliasList', 'orgAliasHistory');
}

function fetchReady(envType) {
  const orgAlias = document.getElementById('orgAlias').value.trim();
  if (!orgAlias) { setStatus('error', 'Enter your Copado org alias or username.'); return; }
  cleanStories     = [];
  projectHeaderMap = {};
  projectLastRow   = {};
  runCompleted     = false;
  document.getElementById('resultsBody').innerHTML = '';
  document.getElementById('results-section').style.display = 'none';
  document.getElementById('promote-section').style.display = 'none';
  document.getElementById('cleanCount').textContent = '0';
  document.getElementById('promoteList').textContent = '';
  setStatus('info', `Fetching ${envType} ready stories from Copado...`, true);
  document.getElementById('verifyBtn').disabled = true;
  document.getElementById('cancelBtn').style.display = 'inline-flex';
  vscode.postMessage({ command: 'fetchReady', envType, orgAlias });
}


function verify() {
  const stories  = document.getElementById('stories').value.trim();
  const orgAlias = document.getElementById('orgAlias').value.trim();
  const repoPath = document.getElementById('repoPath').value.trim();

  if (!stories || !orgAlias) {
    setStatus('error', 'Enter story names and Copado org alias / username before verifying.');
    return;
  }
  currentOrg           = orgAlias;
  cleanStories         = [];
  verifiedStoryNames   = new Set();
  storyWarningMap      = new Map();
  forcePromoStoryNames = new Set();
  runCompleted         = false;
  projectHeaderMap     = {};
  projectLastRow       = {};

  document.getElementById('results-section').style.display = 'none';
  document.getElementById('promote-section').style.display = 'none';
  document.getElementById('pipelineNamesBar').style.display = 'none';
  document.getElementById('pipelineNamesBar').textContent = '';
  document.getElementById('resultsBody').innerHTML = '';
  document.getElementById('verifyBtn').disabled = true;
  document.getElementById('cancelBtn').style.display = 'inline-flex';

  setStatus('info', 'Starting verification...', true);

  saveHistory('orgAliasHistory', orgAlias);
  saveHistory('repoPathHistory', repoPath);
  populateDatalist('orgAliasList', 'orgAliasHistory');
  populateDatalist('repoPathList', 'repoPathHistory');

  vscode.postMessage({ command: 'verify', stories, orgAlias, repoPath });
}

function abort() {
  isPartialReVerify    = false;
  forcePromoStoryNames = new Set();
  vscode.postMessage({ command: 'abort' });
}

function promote() {
  const storiesToPromote = cleanStories.filter(s => !s.skipped);
  if (storiesToPromote.length === 0) return;

  const groupMap = {};
  for (const s of storiesToPromote) {
    // separate wins over retriggerGroup: user explicitly checked the box → own new promotion.
    // retriggerGroup: checkbox unchecked → re-trigger the shared old promotion.
    // Otherwise: group by project + source credential.
    const key = s.separate       ? `__separate__${s.name}`
              : s.retriggerGroup ? `__retrigger__${s.retriggerGroup}`
              : `${s.projectId}::${s.credentialId}`;
    if (!groupMap[key]) {
      groupMap[key] = { projectId: s.projectId, credentialId: s.credentialId, stories: [], storyIds: [],
        // When separate: create new promo + copy attachments. When re-trigger: re-trigger old promo.
        retriggerPromotionId:             s.separate ? null : (s.retriggerPromotionId ?? null),
        retriggerPromotionName:           s.separate ? null : (s.retriggerPromotionName ?? null),
        deployOnly:                       s.separate ? false : (s.deployOnly ?? false),
        conflictResolvedSourcePromoId:    s.separate ? (s.conflictResolvedSourcePromoId ?? null) : null,
        conflictResolvedLatestCommit:     s.separate ? (s.latestCommitDate ?? null) : null,
        conflictResolvedPromoLastMod:     s.separate ? (s.promoLastModifiedDate ?? null) : null };
    }
    groupMap[key].stories.push(s.name);
    groupMap[key].storyIds.push(s.id);
  }

  const groups       = Object.values(groupMap);
  const totalStories = storiesToPromote.length;
  const mergeDeployAfter = document.getElementById('autoMergeDeploy').checked;
  document.getElementById('promoteBtn').disabled = true;
  const action = mergeDeployAfter ? 'Promoting + triggering Merge & Deploy' : 'Creating promotions';
  setStatus('info', `${action} for ${totalStories} stor${totalStories > 1 ? 'ies' : 'y'} across ${groups.length} group${groups.length > 1 ? 's' : ''}...`, true);
  inPromoteMode      = true;
  mergeDeployResults = [];
  vscode.postMessage({ command: 'promote', groups, orgAlias: currentOrg, mergeDeployAfter });
}

function reset() {
  document.getElementById('resultsBody').innerHTML = '';
  document.getElementById('results-section').style.display = 'none';
  document.getElementById('promote-section').style.display = 'none';
  document.getElementById('statusBar').style.display = 'none';
  document.getElementById('verifyBtn').disabled = false;
  document.getElementById('cancelBtn').style.display = 'none';
  document.getElementById('stories').value = '';
  // Ask panel.ts for the current default org (re-reads .sf/config.json fresh)
  vscode.postMessage({ command: 'getDefaultOrg' });
  cleanStories         = [];
  verifiedStoryNames   = new Set();
  storyWarningMap      = new Map();
  forcePromoStoryNames = new Set();
  document.getElementById('promoteList').textContent = '';
  document.getElementById('pipelineNamesBar').style.display = 'none';
  document.getElementById('pipelineNamesBar').textContent = '';
  document.getElementById('debugLog').textContent = '';
  document.getElementById('debugLog').style.display = 'none';
  document.getElementById('debugLogWrap').style.display = 'none';
  document.getElementById('debugToggle').textContent = '▶ Show debug log';
  projectHeaderMap   = {};
  projectLastRow     = {};
  inPromoteMode      = false;
  mergeDeployResults = [];
  isPartialReVerify  = false;
}

function endRun() {
  document.getElementById('verifyBtn').disabled = false;
  document.getElementById('cancelBtn').style.display = 'none';
}

function setStatus(type, msg, spinner = false) {
  const bar = document.getElementById('statusBar');
  bar.style.display = 'flex';
  bar.className = 'status-bar' + (type === 'error' ? ' error' : type === 'success' ? ' success' : type === 'warning' ? ' warning' : '');
  bar.innerHTML = (spinner ? '<div class="spinner"></div>' : '') + `<span>${msg}</span>`;
}

// Ensure project section header exists; returns the header element
function ensureProjectSection(projectId, projectName) {
  if (projectHeaderMap[projectId]) return;
  const tbody = document.getElementById('resultsBody');
  const hdr   = document.createElement('tr');
  hdr.id        = 'proj-hdr-' + projectId;
  hdr.className = 'project-header-row';
  hdr.innerHTML = `<td colspan="20"><div class="project-hdr"><span class="project-dot"></span>${projectName || 'Unknown Project'}</div></td>`;
  tbody.appendChild(hdr);
  projectHeaderMap[projectId] = hdr;
  projectLastRow[projectId]   = hdr;
}

// Move/update a story row into its project section
function insertGroupedRow(storyName, projectId, html) {
  const tbody = document.getElementById('resultsBody');
  const rowId = 'row-' + storyName.replace(/[^a-z0-9]/gi, '_');
  let row = document.getElementById(rowId);
  if (!row) {
    row = document.createElement('tr');
    row.id = rowId;
  }
  row.innerHTML = html;
  // Move row to right after the last element in this project section
  const insertAfter = projectLastRow[projectId];
  tbody.insertBefore(row, insertAfter.nextSibling);
  projectLastRow[projectId] = row;
}

// Plain in-place upsert (for verifying/error states — no project grouping)
function upsertRow(storyName, branch, copadoCommits, extraCommits, unregisteredDetail, verdict, storyCommittedBy, extraCommittedBy) {
  const tbody = document.getElementById('resultsBody');
  const rowId = 'row-' + storyName.replace(/[^a-z0-9]/gi, '_');
  let row = document.getElementById(rowId);
  const html = buildRowHtml(storyName, branch, copadoCommits, extraCommits, unregisteredDetail, verdict, storyCommittedBy, extraCommittedBy);
  if (!row) {
    row = document.createElement('tr');
    row.id = rowId;
    tbody.appendChild(row);
  }
  row.innerHTML = html;
}

function buildRowHtml(storyName, branch, copadoCommits, extraCommits, unregisteredDetail, verdict, storyCommittedBy, extraCommittedBy, tests, prBlocked, hasApexCode, hasDeploymentTasks, parentStory = null, promotionCount = 0, lastPromoWarning = null, srcEnvName = null, dstEnvName = null, stalePromoInfo = null, baseBranch = null, dependencies = []) {
  const failedTests      = (tests || []).filter(t => t.status === 'Failed' || t.status === 'Error');
  const hasApexTest      = (tests || []).some(t => /apex/i.test(t.type || '') || /apex/i.test(t.tool || '') || /apex/i.test(t.name || ''));
  const noApexTestClass  = hasApexCode && !hasApexTest;
  const noCommits           = verdict === 'skip-no-commits';
  const noCommitsNoTasks    = noCommits && !hasDeploymentTasks;
  const commitOk            = (verdict === 'clean' || verdict === 'skip-covered-same-author' || noCommits) && !noCommitsNoTasks;
  const effectivePrBlock    = noCommits ? false : prBlocked;
  const isVerifying         = verdict === 'verifying' || tests === undefined;
  const parentBlocked       = parentStory && !parentStory.promoted;
  const isPromotable        = commitOk && failedTests.length === 0 && !effectivePrBlock && !(noCommits ? false : noApexTestClass) && !parentBlocked;
  const isMergeConflict      = lastPromoWarning?.status === 'Merge Conflict';
  const isInnocentConflict   = isMergeConflict && lastPromoWarning?.isConflictOnCurrentStory === false;
  const isAlreadyInProg      = lastPromoWarning?.status === 'In Progress';
  const isConflictsResolved  = lastPromoWarning?.status === 'Conflicts Resolved';
  const isCRMultiStory       = isConflictsResolved && (lastPromoWarning?.siblingStories?.length ?? 0) > 0;
  const isValidatedPromo     = lastPromoWarning?.status === 'Validated';
  const isValidatedMultiStory = isValidatedPromo && (lastPromoWarning?.siblingStories?.length ?? 0) > 0;
  const isFailedPromo        = lastPromoWarning?.status === 'Completed with errors' || lastPromoWarning?.status === 'Validation failed';
  const isForcePromo         = isPromotable && isFailedPromo; // eligible technically but last promo failed with no fix commit
  const dependencyBlocked    = dependencies.some(d => !d.parentAhead);
  const isForceDepBlocked    = isPromotable && dependencyBlocked && !isForcePromo; // parent story not yet ahead in pipeline

  const LBL  = 'color:#5a8a9f;font-size:10px;white-space:nowrap;flex-shrink:0';
  const ROW  = 'display:flex;align-items:baseline;gap:5px;margin-top:2px';
  const OK   = 'color:#34d399;font-size:10px';
  const ERR  = 'color:#f85149;font-size:10px';
  const WARN = 'color:#e3b341;font-size:10px';

  function kv(label, valueHtml) {
    return `<div style="${ROW}"><span style="${LBL}">${label}</span>${valueHtml}</div>`;
  }

  let promotableHtml;
  if (isVerifying) {
    promotableHtml = '—';
  } else {
    const badge = (isPromotable && !isForcePromo && !isForceDepBlocked)
      ? `<span class="tag tag-clean" style="font-size:11px">✓ Yes</span>`
      : `<span class="tag tag-error" style="font-size:11px">✗ No</span>`;

    const rows = [];
    if (baseBranch) {
      const parentCred = parentStory?.credential
        ? `<span style="color:#7dd3fc;font-size:10px"> · ${parentStory.credential}</span>`
        : '';
      rows.push(kv('Base branch:', `<span style="color:#fbbf24;font-size:10px">${baseBranch}</span>${parentCred}`));
    }
    if (parentBlocked) {
      rows.push(kv('Parent:', `<span style="${ERR}">⛔ ${parentStory.name} not yet deployed</span>`));
    }
    if (noCommitsNoTasks) {
      rows.push(kv('Commits:', `<span style="${ERR}">✗ No commits or deployment tasks on story</span>`));
    }
    if (!noCommits && prBlocked !== undefined) {
      rows.push(kv('PR:', effectivePrBlock
        ? `<span style="${ERR}">✗ Not approved</span>`
        : `<span style="${OK}">✓ Approved</span>`));
    }
    if (!noCommits && hasApexCode && !hasApexTest) {
      rows.push(kv('Apex Tests:', `<span style="${ERR}">✗ No test record found</span>`));
    }
    (tests || []).forEach(t => {
      const ok    = t.status === 'Success';
      const col   = ok ? OK : (t.status === 'Failed' || t.status === 'Error' ? ERR : WARN);
      const label = t.tool || t.type || (t.name || '').replace(/\s*-\s*US-\d+.*/i, '').trim() || 'Apex Tests';
      rows.push(kv(`${label}:`, `<span style="${col}">${ok ? '✓' : '✗'} ${t.status || '—'}</span>`));
    });
    if (lastPromoWarning && !isMergeConflict && !isAlreadyInProg) {
      const { status, name } = lastPromoWarning;
      let badgeSpan;
      if (status === 'Completed with errors') {
        badgeSpan = `<span style="color:#f59e0b;font-size:11px">✗ Failed — no fix commit</span>`;
      } else if (status === 'Validation failed') {
        badgeSpan = `<span style="color:#f59e0b;font-size:11px">✗ Validation failed — no fix commit</span>`;
      } else if (status === 'Validated') {
        badgeSpan = `<span style="color:#f59e0b;font-size:11px">⚠ Validated only — not deployed</span>`;
      } else {
        badgeSpan = `<span style="color:#f59e0b;font-size:11px">⚠ Conflicts resolved — re-initiate promotion</span>`;
      }
      rows.push(kv('Last promo:', `${badgeSpan}<br><span style="color:#94a3b8;font-size:10px">${name}</span>`));
      const sibs = lastPromoWarning.siblingStories ?? [];
      if (sibs.length > 0) {
        const sibLines = sibs.map(s => {
          const inList   = verifiedStoryNames.has((s.name ?? '').toUpperCase());
          const eligible = inList && cleanStories.some(c => c.name.toUpperCase() === (s.name ?? '').toUpperCase());
          const statusTag = inList
            ? (eligible
                ? `<span data-sib-tag="${(s.name ?? '').toUpperCase()}" style="color:#34d399;font-size:9px;font-weight:600;margin-left:8px">● eligible</span>`
                : `<span data-sib-tag="${(s.name ?? '').toUpperCase()}" style="color:#f87171;font-size:9px;font-weight:600;margin-left:8px">● not eligible</span>`)
            : `<span data-sib-tag="${(s.name ?? '').toUpperCase()}" style="color:#475569;font-size:9px;margin-left:8px">● not in list</span>`;
          return `<div style="margin-top:4px;display:flex;align-items:baseline;gap:0;flex-wrap:wrap">` +
            `<span style="color:#f8fafc;font-size:11px;font-weight:600">${s.name ?? ''}</span>` +
            (s.credential ? `<span style="color:#7dd3fc;font-size:10px"> · ${s.credential}</span>` : '') +
            (s.developer  ? `<span style="color:#94a3b8;font-size:10px"> · ${s.developer}</span>`  : '') +
            statusTag +
            `</div>`;
        }).join('');
        rows.push(`<div style="margin-top:6px;padding:8px 12px;background:rgba(217,119,6,0.07);border-left:2px solid #b45309;border-radius:0 4px 4px 0">` +
          `<div style="color:#d97706;font-size:10px;font-weight:700;letter-spacing:0.4px;margin-bottom:2px">Also in promotion — ${name}</div>` +
          sibLines +
          `</div>`);
      }
    }
    if (stalePromoInfo) {
      const { status: staleStatus, name: staleName } = stalePromoInfo;
      rows.push(kv('Last promo:', `<span style="color:#34d399;font-size:11px">✓ Fix committed after last ${staleStatus}</span><br><span style="color:#94a3b8;font-size:10px">${staleName}</span>`));
    }
    if (dependencies.length > 0) {
      const depLines = dependencies.map(d => {
        const ahead     = d.parentAhead;
        const envCol    = ahead ? '#34d399' : '#f59e0b';
        const envIcon   = ahead ? '✓' : '⚠';
        const relLabel  = d.relationshipType ? `<span style="color:#475569;font-size:9px;margin-left:4px">[${d.relationshipType}]</span>` : '';
        return `<div style="margin-top:4px;display:flex;align-items:baseline;gap:0;flex-wrap:wrap">` +
          `<span style="color:#f8fafc;font-size:11px;font-weight:600">${d.parentName}</span>` +
          (d.parentEnv      ? `<span style="color:${envCol};font-size:10px"> · ${envIcon} ${d.parentEnv}</span>` : '') +
          (d.parentDeveloper ? `<span style="color:#94a3b8;font-size:10px"> · ${d.parentDeveloper}</span>` : '') +
          relLabel +
          `</div>`;
      }).join('');
      const hasBlocked = dependencies.some(d => !d.parentAhead);
      const borderCol  = hasBlocked ? '#b45309' : '#065f46';
      const titleCol   = hasBlocked ? '#d97706' : '#34d399';
      const title      = hasBlocked ? '⚠ Parent not yet ahead — Force to promote anyway' : '✓ Parent already ahead in pipeline';
      rows.push(`<div style="margin-top:6px;padding:8px 12px;background:rgba(217,119,6,0.07);border-left:2px solid ${borderCol};border-radius:0 4px 4px 0">` +
        `<div style="color:${titleCol};font-size:10px;font-weight:700;letter-spacing:0.4px;margin-bottom:2px">${title}</div>` +
        depLines +
        `</div>`);
    }

    // Not-eligible badge: culprit Merge Conflict or In Progress
    let notEligibleBadge = '';
    if (isMergeConflict && !isInnocentConflict) {
      notEligibleBadge = `<span style="display:inline-block;background:#451a03;border:1px solid #d97706;color:#fbbf24;font-size:10px;padding:2px 8px;border-radius:4px;white-space:nowrap;margin-top:4px">` +
        `⚠ Merge Conflict — ${lastPromoWarning.name}</span>`;
    } else if (isAlreadyInProg) {
      const jeStatus   = lastPromoWarning.jeStatus ?? 'In Progress';
      const isQueued   = jeStatus === 'Queued';
      const borderCol  = isQueued ? '#d97706' : '#10b981';
      const lblCol     = isQueued ? '#fbbf24' : '#34d399';
      const spinBorder = isQueued ? '#92400e' : '#065f46';
      const spinTop    = isQueued ? '#f59e0b' : '#10b981';
      const spinWidth  = isQueued ? '1.5px' : '2.5px';
      const label      = isQueued ? 'In Queue' : 'In Progress';
      const weight     = isQueued ? '600' : '400';
      notEligibleBadge =
        `<span style="display:inline-flex;align-items:center;gap:6px;background:#18181b;border:1px solid ${borderCol};border-radius:6px;padding:3px 10px;font-size:11px;white-space:nowrap;margin-top:4px">` +
        `<span style="width:10px;height:10px;border:${spinWidth} solid ${spinBorder};border-top-color:${spinTop};border-radius:50%;animation:spin .8s linear infinite;flex-shrink:0;display:inline-block"></span>` +
        `<span style="color:${lblCol};font-weight:${weight}">${label}</span>` +
        `<span style="color:#e3b341;font-weight:500">${lastPromoWarning.name}</span>` +
        `</span>`;
    }

    // Info badge (non-culprit story in a Merge Conflict promotion)
    let innocentBadge = '';
    if (isInnocentConflict) {
      const culprit  = lastPromoWarning.conflictCulprit ?? 'unknown story';
      const merged   = lastPromoWarning.mergedIntoPromotion;
      const mergeLabel = merged === true  ? `✓ Merged into ${lastPromoWarning.name}`
                       : merged === false ? `ℹ Not yet merged in ${lastPromoWarning.name}`
                       : `ℹ Merge order unknown in ${lastPromoWarning.name}`;
      // data-culprit used by done handler to append "(also in this list — not eligible)" if culprit verified
      innocentBadge =
        `<span data-innocent-badge data-culprit="${culprit}" style="display:inline-block;background:#0c2340;border:1px solid #1ab8e8;color:#7fc9e0;font-size:10px;padding:2px 8px;border-radius:4px;white-space:nowrap;margin-top:4px">` +
        `${mergeLabel} — conflict caused by ${culprit}<span class="culprit-in-list-note"></span></span>`;
    }

    promotableHtml = `<div style="display:flex;flex-direction:column;align-items:flex-start">${badge}${notEligibleBadge}${innocentBadge}${rows.join('')}</div>`;
  }

  const verdictHtml = verdict === 'verifying'
    ? `<span class="tag tag-verifying">Verifying...</span>`
    : verdict === 'clean'
    ? `<span class="tag tag-clean">✓ Clean</span>`
    : verdict === 'skip-covered-same-author'
    ? `<span class="tag tag-covered-same">✓ Covered (same author)</span>`
    : verdict === 'skip-needs-verify'
    ? `<span class="tag tag-needs-verify">⚠ Needs Verify</span>`
    : verdict === 'skip-no-commits'
    ? `<span class="tag tag-skip">⚠ No commits</span>`
    : verdict === 'skip-unregistered'
    ? `<span class="tag tag-error">✗ Unregistered</span>`
    : verdict === 'promoted'
    ? `<span class="tag tag-promoted">✓ Promoted</span>`
    : verdict === 'promote-failed'
    ? `<span class="tag tag-error">✗ Promote failed</span>`
    : `<span class="tag tag-error">✗ Error</span>`;

  const detail = unregisteredDetail || [];
  let unregHtml;
  if (detail.length === 0 && verdict !== 'verifying' && extraCommits !== null) {
    unregHtml = '<span style="color:#34d399">None</span>';
  } else if (detail.length === 0) {
    unregHtml = '—';
  } else {
    unregHtml = detail.map(d => {
      if (d._errorMsg) return `<span style="color:#f85149;font-size:11px">${d._errorMsg}</span>`;
      if (d.copadoStatus && d.copadoStatus !== 'Failed') {
        return [
          `<span class="hash-list" style="color:#2a6a8a">${d.sha}</span>`,
          `<span style="color:#f85149;font-size:10px">⛔ Registered in Copado with '${d.copadoStatus}' status</span>`,
          d.commitMessage ? `<span style="color:#2a6a8a;font-size:10px;display:block;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${d.commitMessage}">${d.commitMessage}</span>` : '',
        ].filter(Boolean).join('<br>');
      }
      if (d.copadoAuto) {
        return [
          `<span class="hash-list" style="color:#2a6a8a">${d.sha}</span>`,
          `<span style="color:#1ab8e8;font-size:10px">⚡ Copado auto-commit (exempt)</span>`,
          `<span style="color:#2a6a8a;font-size:10px;display:block;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${d.commitMessage}">${d.commitMessage}</span>`,
        ].join('<br>');
      }
      const lines = [`<span class="hash-list" style="color:#2a6a8a">${d.sha}</span>`];
      if (d.copadoStatus === 'Failed')
        lines.push(`<span style="color:#e3b341;font-size:10px">⚠ Registered in Copado with 'Failed' status — checking metadata coverage</span>`);
      if (d.coveredComponents && d.coveredComponents.length > 0)
        lines.push(`<span style="color:#e3b341;font-size:10px">In metadata:<br>${d.coveredComponents.join('<br>')}</span>`);
      if (d.uncoveredComponents && d.uncoveredComponents.length > 0)
        lines.push(`<span style="color:#f85149;font-size:10px">Not in metadata:<br>${d.uncoveredComponents.join('<br>')}</span>`);
      if (d.authorMismatch)
        lines.push(`<span style="color:#f85149;font-size:10px">⚠ Different author: ${d.authorName || d.authorEmail}</span>`);
      if (d.isAmended)
        lines.push(`<span style="color:#e3b341;font-size:10px">✎ Amended commit — originally by ${d.authorName || d.authorEmail}, committed by ${d.committerName || 'unknown'}</span>`);
      return lines.join('<br>');
    }).join('<hr style="border-color:rgba(26,184,232,0.1);margin:4px 0">');
  }

  const extraHtml  = extraCommits  !== null ? `${extraCommits.length} commit${extraCommits.length !== 1 ? 's' : ''}`   : '—';
  const copadoHtml = copadoCommits !== null ? `${copadoCommits.length} commit${copadoCommits.length !== 1 ? 's' : ''}` : '—';

  const storyByHtml = (storyCommittedBy || []).length > 0
    ? (storyCommittedBy || []).map(n => `<span style="font-size:11px">${n}</span>`).join('<br>')
    : '—';

  const extraByHtml = (extraCommittedBy || []).length > 0
    ? (extraCommittedBy || []).map(n => `<span style="font-size:11px">${n}</span>`).join('<br>')
    : (verdict === 'verifying' || extraCommits === null ? '—' : '<span style="color:#34d399;font-size:11px">None</span>');

  // A story is "will be promoted" only if it passes the same gate as the cleanStories eligibility check:
  // no warning, OR Conflicts Resolved, OR innocent Merge Conflict. Only these get interactive checkboxes.
  const willBePromoted = isPromotable && !isForcePromo && !isForceDepBlocked && (!lastPromoWarning || isConflictsResolved || isInnocentConflict || isValidatedPromo);

  // Skip: only for stories that will actually be promoted
  const showSkip = willBePromoted;
  const skipTd = (isForcePromo || isForceDepBlocked)
    ? `<td style="text-align:center;vertical-align:middle">
         <label style="display:flex;align-items:center;justify-content:center;gap:4px;cursor:pointer"
                title="${isForceDepBlocked ? 'Parent story not yet ahead in pipeline. Check to force-promote anyway.' : 'Last promotion failed with no fix commit. Check to force-promote anyway.'}">
           <input type="checkbox" class="force-promote-cb" data-story="${storyName}"
             style="width:13px;height:13px;accent-color:#f59e0b;cursor:pointer" />
           <span style="font-size:9px;color:#f59e0b;font-weight:600">Force</span>
         </label>
       </td>`
    : showSkip
    ? `<td style="text-align:center;vertical-align:middle">
         <label style="display:flex;align-items:center;justify-content:center;cursor:pointer">
           <input type="checkbox" class="skip-story-cb" data-story="${storyName}"
             style="width:13px;height:13px;accent-color:#f59e0b;cursor:pointer" />
         </label>
       </td>`
    : `<td></td>`;
  // Separate Promo: shown for normal eligible stories and innocent Merge Conflict stories.
  // Innocent conflict stories show the checkbox unchecked — user decides whether to promote separately.
  // CR multi-story stories get a hidden cell that the done handler reveals only when some siblings are missing.
  const separateTd = (willBePromoted && (!lastPromoWarning || isInnocentConflict))
    ? `<td style="text-align:center;vertical-align:middle">
         <label style="display:flex;align-items:center;justify-content:center;cursor:pointer">
           <input type="checkbox" class="separate-promo-cb" data-story="${storyName}"
             style="width:13px;height:13px;accent-color:#1ab8e8;cursor:pointer" />
         </label>
       </td>`
    : (isCRMultiStory && isPromotable)
    ? `<td style="text-align:center;vertical-align:middle">
         <label style="display:inline-flex;flex-direction:column;align-items:center;cursor:pointer;gap:3px;
                       border:1px solid ${lastPromoWarning?.resolutionsStale ? '#4a1a1a' : '#2a4a5a'};border-radius:4px;padding:4px 6px;background:#0a1a26">
           <input type="checkbox" class="separate-promo-cb" data-story="${storyName}"
             style="width:13px;height:13px;accent-color:#1ab8e8;cursor:pointer" />
           <span style="font-size:8px;color:${lastPromoWarning?.resolutionsStale ? '#f87171' : '#5a8a9f'};text-align:center;max-width:90px;white-space:normal;line-height:1.2">
             ${lastPromoWarning?.resolutionsStale ? '[resolutions stale — not copied]' : '[resolution attachments will be copied for this US if any]'}
           </span>
         </label>
         <div data-cr-sibling-note style="display:none;font-size:8px;color:#f97316;margin-top:4px;max-width:110px;white-space:normal;line-height:1.3;text-align:center"></div>
       </td>`
    : `<td></td>`;

  const envLabel = srcEnvName
    ? (dstEnvName ? `${srcEnvName.toUpperCase()} → ${dstEnvName.toUpperCase()}` : srcEnvName.toUpperCase())
    : '—';

  return `
    <td><strong style="color:#e0f4ff">${storyName}</strong></td>
    <td style="font-size:11px;color:#5a8a9f;white-space:nowrap">${envLabel}</td>
    <td style="font-family:monospace;font-size:11px;color:#2a6a8a">${branch || '—'}</td>
    <td>${copadoHtml}</td>
    <td>${storyByHtml}</td>
    <td>${extraHtml}</td>
    <td>${extraByHtml}</td>
    <td>${unregHtml}</td>
    <td>${verdictHtml}</td>
    <td>${promotableHtml}</td>
    ${skipTd}
    ${separateTd}
  `;
}

window.addEventListener('message', (event) => {
  const msg = event.data;

  if (msg.type === 'debug') {
    document.getElementById('debugLogWrap').style.display = 'block';
    const log = document.getElementById('debugLog');
    log.textContent += msg.message + '\n';
    if (log.style.display !== 'none') log.scrollTop = log.scrollHeight;
  }

  else if (msg.type === 'pipeline-names') {
    const bar = document.getElementById('pipelineNamesBar');
    bar.textContent = 'Pipeline: ' + msg.names.join('  |  ');
    bar.style.display = 'block';
  }

  else if (msg.type === 'fetch-stories-found') {
    setStatus('info', `Found ${msg.count} ${msg.envType} ready stories — checking promotion history...`, true);
  }

  else if (msg.type === 'fetch-unchecked') {
    // Story auto-unchecked in Copado — no UI action needed, runner already skipped it
  }

  else if (msg.type === 'fetch-done') {
    const stories = msg.stories ?? [];
    document.getElementById('stories').value = stories.join('\n');
    if (msg.repoPath) {
      document.getElementById('repoPath').value = msg.repoPath;
      saveHistory('repoPathHistory', msg.repoPath);
      populateDatalist('repoPathList', 'repoPathHistory');
    }
    document.getElementById('verifyBtn').disabled = false;
    document.getElementById('cancelBtn').style.display = 'none';
    if (stories.length === 0) {
      setStatus('info', `No stories available in the ${msg.envType ?? ''} list view to fetch.`);
    } else {
      setStatus('success', `${stories.length} stor${stories.length === 1 ? 'y' : 'ies'} loaded. Click Verify Stories to proceed.`);
    }
  }

  else if (msg.type === 'run-start') {
    setStatus('info', 'Connecting to Copado org...', true);
    const log = document.getElementById('debugLog');
    log.textContent = '';
    log.style.display = 'none';
    document.getElementById('debugLogWrap').style.display = 'none';
    document.getElementById('debugToggle').textContent = '▶ Show debug log';
  }

  else if (msg.type === 'start') {
    if (isPartialReVerify) {
      // Only update the force rows in-place — leave rest of table untouched
      msg.storyNames.forEach(n => upsertRow(n, '', null, null, null, 'verifying', null, null));
      setStatus('info', `Re-verifying ${msg.storyNames.length} force stor${msg.storyNames.length === 1 ? 'y' : 'ies'}...`, true);
    } else {
      document.getElementById('results-section').style.display = 'block';
      projectHeaderMap = {};
      projectLastRow   = {};
      msg.storyNames.forEach(n => upsertRow(n, '', null, null, null, 'verifying', null, null));
      setStatus('info', 'Querying Copado...', true);
    }
  }

  else if (msg.type === 'stderr') {
    runCompleted = true;
    setStatus('error', `sf: ${msg.message}`);
    endRun();
  }

  else if (msg.type === 'default-org') {
    document.getElementById('orgAlias').value = msg.org ?? '';
  }

  else if (msg.type === 'aborted') {
    runCompleted = true;
    setStatus('warning', 'Cancelled.');
    endRun();
  }

  else if (msg.type === 'validation-error') {
    runCompleted = true;
    setStatus('error', msg.message);
    endRun();
  }

  else if (msg.type === 'fatal') {
    runCompleted = true;
    setStatus('error', msg.message);
    endRun();
  }

  else if (msg.type === 'effective-repo-path') {
    // Runner resolved the actual local path (user-provided or auto-cloned temp dir).
    // Show it in the field so the user can see where it lives.
    if (msg.repoPath) {
      const field = document.getElementById('repoPath');
      field.value = msg.repoPath;
      saveHistory('repoPathHistory', msg.repoPath);
      populateDatalist('repoPathList', 'repoPathHistory');
    }
  }

  else if (msg.type === 'git-clone-start') {
    setStatus('info', `First-time setup: cloning ${msg.repoName} from GitHub (one-time only, please wait)...`, true);
  }

  else if (msg.type === 'git-clone-done') {
    setStatus('info', 'Clone complete. Starting verification...', true);
  }

  else if (msg.type === 'git-fetch-start') {
    setStatus('info', 'Running git fetch origin...', true);
  }

  else if (msg.type === 'git-fetch-done') {
    setStatus('info', 'Git refs up to date. Verifying stories...', true);
  }

  else if (msg.type === 'story-verifying') {
    upsertRow(msg.storyName, msg.branch, null, null, null, 'verifying', null, null);
    setStatus('info', `Verifying ${msg.storyName}...`, true);
  }

  else if (msg.type === 'story-error') {
    upsertRow(msg.storyName, '', [], [], [], 'error', [], []);
  }

  else if (msg.type === 'story-verified') {
    const failedTests     = (msg.tests || []).filter(t => t.status === 'Failed' || t.status === 'Error');
    const prBlocked       = msg.hasMetadata && !msg.prApproved;
    const hasApexTest     = (msg.tests || []).some(t => /apex/i.test(t.type || '') || /apex/i.test(t.tool || '') || /apex/i.test(t.name || ''));
    const noApexTestClass = msg.hasApexCode && !hasApexTest;
    const parentBlocked       = msg.parentStory && !msg.parentStory.promoted;
    const noCommitsNoTasks    = msg.verdict === 'skip-no-commits' && !msg.hasDeploymentTasks;
    // Compute resolutionsStale for CR multi-story: if developer committed after conflict was resolved,
    // RESOLVED attachments from old promotion no longer apply to the new code.
    let lastPromoWarningForRow = msg.lastPromoWarning ?? null;
    if (lastPromoWarningForRow?.status === 'Conflicts Resolved'
        && (lastPromoWarningForRow.siblingStories?.length ?? 0) > 0) {
      const lcd  = msg.latestCommitDate ?? null;
      const lucd = msg.latestUnregisteredCommitDate ?? null;
      // Use the later of Copado-registered commit date and the latest unregistered commit's date.
      // lucd catches commits pushed to git but missed by Copado — those make resolutions stale too.
      const effectiveLcd = (!lcd && !lucd) ? null
        : !lcd  ? lucd
        : !lucd ? lcd
        : new Date(lcd) >= new Date(lucd) ? lcd : lucd;
      const pmd = lastPromoWarningForRow.lastModifiedDate;
      lastPromoWarningForRow = {
        ...lastPromoWarningForRow,
        resolutionsStale: !effectiveLcd || !pmd || new Date(effectiveLcd) >= new Date(pmd),
      };
    }
    const html = buildRowHtml(
      msg.storyName, msg.branch, msg.copadoCommits, msg.extraCommits,
      msg.unregisteredDetail, msg.verdict, msg.storyCommittedBy, msg.extraCommittedBy,
      msg.tests, prBlocked, msg.hasApexCode, msg.hasDeploymentTasks ?? false,
      msg.parentStory ?? null, msg.promotionCount ?? 0, lastPromoWarningForRow,
      msg.srcEnvName ?? null, msg.dstEnvName ?? null, msg.stalePromoInfo ?? null, msg.baseBranch ?? null,
      msg.dependencies ?? []
    );
    ensureProjectSection(msg.projectId, msg.projectName);
    insertGroupedRow(msg.storyName, msg.projectId, html);

    verifiedStoryNames.add(msg.storyName.toUpperCase());
    storyWarningMap.set(msg.storyName.toUpperCase(), msg.lastPromoWarning ?? null);

    const isLastPromoWarning  = !!msg.lastPromoWarning;
    const isConflictsResolved = msg.lastPromoWarning?.status === 'Conflicts Resolved';
    const isValidatedPromo    = msg.lastPromoWarning?.status === 'Validated';
    const isFailedPromo       = msg.lastPromoWarning?.status === 'Completed with errors' || msg.lastPromoWarning?.status === 'Validation failed';
    // Innocent Merge Conflict: another story caused the conflict; current story still eligible but needs separate promo.
    const isInnocentConflict  = msg.lastPromoWarning?.status === 'Merge Conflict'
                                && msg.lastPromoWarning?.isConflictOnCurrentStory === false;
    const noCommits          = msg.verdict === 'skip-no-commits';
    const dependencyBlocked  = (msg.dependencies ?? []).some(d => !d.parentAhead);
    const isEligible = (msg.verdict === 'clean' || msg.verdict === 'skip-covered-same-author' || noCommits)
        && !noCommitsNoTasks
        && failedTests.length === 0 && !(noCommits ? false : prBlocked) && !(noCommits ? false : noApexTestClass) && !parentBlocked
        && !dependencyBlocked;

    if (isEligible) {
      if (!isLastPromoWarning || isConflictsResolved || isInnocentConflict || isValidatedPromo) {
        // If this story was previously force-flagged (re-verify scenario), remove it now that it's eligible.
        forcePromoStoryNames.delete(msg.storyName);
        const entry = {
          name: msg.storyName, id: msg.storyId,
          projectId: msg.projectId, credentialId: msg.credentialId,
          projectName: msg.projectName ?? '',
          // Innocent Merge Conflict always separate. CR multi-story defaults unchecked (re-trigger).
          separate: false,
          skipped: false,
          developer: msg.storyDeveloper ?? '',
          promoWarning: isInnocentConflict ? { name: msg.lastPromoWarning?.name, status: msg.lastPromoWarning?.status } : null,
        };
        if (isConflictsResolved || isValidatedPromo) {
          entry.retriggerPromotionId   = msg.lastPromoWarning.id;
          entry.retriggerPromotionName = msg.lastPromoWarning.name;
          entry.siblingStories         = msg.lastPromoWarning.siblingStories ?? [];
          if (isValidatedPromo) entry.deployOnly = true;
          if (isConflictsResolved && (msg.lastPromoWarning.siblingStories?.length ?? 0) > 0) {
            // Attachment copy only applies to Conflicts Resolved re-triggers.
            const _lcd  = msg.latestCommitDate ?? null;
            const _lucd = msg.latestUnregisteredCommitDate ?? null;
            const _eff  = (!_lcd && !_lucd) ? null
              : !_lcd  ? _lucd
              : !_lucd ? _lcd
              : new Date(_lcd) >= new Date(_lucd) ? _lcd : _lucd;
            entry.conflictResolvedSourcePromoId = msg.lastPromoWarning.id;
            entry.latestCommitDate              = _eff;
            entry.promoLastModifiedDate         = msg.lastPromoWarning.lastModifiedDate ?? null;
          }
        }
        cleanStories.push(entry);
      } else if (isFailedPromo) {
        // Last promo failed with no fix commit — not auto-eligible; user must check "Force" to include.
        forcePromoStoryNames.add(msg.storyName);
        const entry = {
          name: msg.storyName, id: msg.storyId,
          projectId: msg.projectId, credentialId: msg.credentialId,
          projectName: msg.projectName ?? '',
          separate: false, skipped: false,
          developer: msg.storyDeveloper ?? '',
          forcePromo: true,
        };
        const row = document.getElementById('row-' + msg.storyName.replace(/[^a-z0-9]/gi, '_'));
        const forceCb = row?.querySelector(`.force-promote-cb[data-story="${msg.storyName}"]`);
        if (forceCb) {
          forceCb.addEventListener('change', () => {
            const idx = cleanStories.findIndex(s => s.name === msg.storyName);
            if (forceCb.checked && idx === -1) cleanStories.push(entry);
            else if (!forceCb.checked && idx !== -1) cleanStories.splice(idx, 1);
            updatePromoteCount();
            // Show/hide promote section — may have been hidden if no eligible stories at done time
            const promoSection = document.getElementById('promote-section');
            if (cleanStories.length > 0) {
              promoSection.style.display = 'block';
              document.getElementById('promoteBtn').disabled = false;
            } else {
              promoSection.style.display = 'none';
            }
          });
        }
        // No push to cleanStories — only added when user checks Force
        return; // skip normal checkbox wiring below
      }
    } else if (dependencyBlocked) {
      // Story is otherwise eligible but a parent story is not yet ahead in the pipeline.
      // Treat same as isFailedPromo: show Force checkbox, not auto-included.
      forcePromoStoryNames.add(msg.storyName);
      const entry = {
        name: msg.storyName, id: msg.storyId,
        projectId: msg.projectId, credentialId: msg.credentialId,
        projectName: msg.projectName ?? '',
        separate: false, skipped: false,
        developer: msg.storyDeveloper ?? '',
        forcePromo: true,
      };
      const row = document.getElementById('row-' + msg.storyName.replace(/[^a-z0-9]/gi, '_'));
      const forceCb = row?.querySelector(`.force-promote-cb[data-story="${msg.storyName}"]`);
      if (forceCb) {
        forceCb.addEventListener('change', () => {
          const idx = cleanStories.findIndex(s => s.name === msg.storyName);
          if (forceCb.checked && idx === -1) cleanStories.push(entry);
          else if (!forceCb.checked && idx !== -1) cleanStories.splice(idx, 1);
          updatePromoteCount();
          const promoSection = document.getElementById('promote-section');
          if (cleanStories.length > 0) {
            promoSection.style.display = 'block';
            document.getElementById('promoteBtn').disabled = false;
          } else {
            promoSection.style.display = 'none';
          }
        });
      }
      return;
    }

    // Wire checkboxes for all eligible stories
      const row = document.getElementById('row-' + msg.storyName.replace(/[^a-z0-9]/gi, '_'));
      if (row) {
        // Separate Promo checkbox
        const cb = row.querySelector(`.separate-promo-cb[data-story="${msg.storyName}"]`);
        if (cb) {
          cb.addEventListener('change', () => {
            const s = cleanStories.find(s => s.name === msg.storyName);
            if (s) s.separate = cb.checked;
            // Mutual exclusion: separate clears skip
            if (cb.checked) {
              const skipCb = row.querySelector(`.skip-story-cb[data-story="${msg.storyName}"]`);
              if (skipCb && skipCb.checked) { skipCb.checked = false; if (s) s.skipped = false; }
            }
            updatePromoteCount();
          });
        }

        // Skip checkbox
        const skipCb = row.querySelector(`.skip-story-cb[data-story="${msg.storyName}"]`);
        if (skipCb) {
          skipCb.addEventListener('change', () => {
            const s = cleanStories.find(s => s.name === msg.storyName);
            if (!s) return;
            s.skipped = skipCb.checked;
            // Mutual exclusion: skip clears separate
            if (skipCb.checked && cb && cb.checked) { cb.checked = false; s.separate = false; }
            updatePromoteCount();
          });
        }
      }
    }

  else if (msg.type === 'done') {
    runCompleted = true;
    endRun();

    if (isPartialReVerify) {
      isPartialReVerify = false;
      updatePromoteCount(); // also updates reVerifyForceWrap visibility via forcePromoStoryNames
      if (cleanStories.length > 0 || forcePromoStoryNames.size > 0) {
        document.getElementById('promote-section').style.display = 'block';
        if (cleanStories.length > 0) document.getElementById('promoteBtn').disabled = false;
      }
      setStatus('success', forcePromoStoryNames.size > 0
        ? `Re-verify complete — ${forcePromoStoryNames.size} stor${forcePromoStoryNames.size === 1 ? 'y' : 'ies'} still require force promote.`
        : 'Re-verify complete — force stories are now normally eligible.');
      return;
    }

    if (inPromoteMode) {
      inPromoteMode = false;
      // Re-enable promote button with remaining eligible stories (if any)
      updatePromoteCount();
      if (cleanStories.length > 0) {
        document.getElementById('promote-section').style.display = 'block';
        document.getElementById('promoteBtn').disabled = false;
      } else {
        document.getElementById('promote-section').style.display = 'none';
      }
      return; // promote-summary already set the status bar
    }

    // Post-process Conflicts Resolved multi-story groups.
    // If ALL sibling stories from the promotion are present in cleanStories → safe to re-trigger together.
    // If some are missing → fall back to treating each as a normal eligible story (separate new promotion).
    const retriggerGroups = {};
    for (const s of cleanStories) {
      if (!s.retriggerPromotionId) continue;
      if (!retriggerGroups[s.retriggerPromotionId]) retriggerGroups[s.retriggerPromotionId] = [];
      retriggerGroups[s.retriggerPromotionId].push(s);
    }
    for (const [promoId, group] of Object.entries(retriggerGroups)) {
      // Store retriggerGroup on every story so that when the user UNCHECKS the separate-promo
      // checkbox, promote() can route it back into the shared re-trigger group key.
      for (const s of group) s.retriggerGroup = promoId;

      // Detect siblings from this promotion that are absent or ineligible.
      // If any are not safe to re-trigger with, default to separate promo and warn on each row.
      const groupNames         = new Set(group.map(s => s.name.toUpperCase()));
      const eligibleStoryNames = new Set(cleanStories.map(s => s.name.toUpperCase()));
      // Build dedup map: upperName → { name, credential } from all sibling arrays in this group
      const siblingMap = new Map();
      for (const s of group) {
        for (const sib of (s.siblingStories ?? [])) {
          const key = sib.name.toUpperCase();
          if (!siblingMap.has(key)) siblingMap.set(key, sib);
        }
      }
      const absentSiblings     = [...siblingMap.values()].filter(sib =>
        !verifiedStoryNames.has(sib.name.toUpperCase()) && !groupNames.has(sib.name.toUpperCase()));
      const ineligibleSiblings = [...siblingMap.values()].filter(sib =>
        verifiedStoryNames.has(sib.name.toUpperCase()) && !eligibleStoryNames.has(sib.name.toUpperCase()));
      if (absentSiblings.length > 0 || ineligibleSiblings.length > 0) {
        const fmt = sib => `${sib.name}${sib.credential ? ` (${sib.credential.toUpperCase()})` : ''}`;
        const noteLines = [];
        if (absentSiblings.length > 0)
          noteLines.push(`<span style="color:#f87171;display:block">Missing from current list — ${absentSiblings.map(fmt).join(', ')}</span>`);
        if (ineligibleSiblings.length > 0)
          noteLines.push(`<span style="color:#fbbf24;display:block">In list, but not eligible to promote — ${ineligibleSiblings.map(fmt).join(', ')}</span>`);
        const noteHtml = noteLines.join('');
        for (const s of group) {
          const row = document.getElementById('row-' + s.name.replace(/[^a-z0-9]/gi, '_'));
          if (!row) continue;
          const note = row.querySelector('[data-cr-sibling-note]');
          if (note) { note.innerHTML = noteHtml; note.style.display = ''; }
        }
      }
    }

    // If the culprit story that caused a Merge Conflict is also in the current verify list,
    // update the innocent badge to say "(also in this list — not eligible)" for extra context.
    document.querySelectorAll('[data-innocent-badge]').forEach(span => {
      const culprit = span.getAttribute('data-culprit');
      if (culprit && verifiedStoryNames.has(culprit.toUpperCase())) {
        const note = span.querySelector('.culprit-in-list-note');
        if (note) note.textContent = ' (also in this list — not eligible)';
      }
    });

    // Refresh all sibling status tags now that ALL stories have been verified.
    // At story-verified time the sibling may not have been processed yet, so the
    // tag was rendered as "not in list" even when the sibling is present and eligible.
    const eligibleNames = new Set(cleanStories.map(s => s.name.toUpperCase()));
    document.querySelectorAll('[data-sib-tag]').forEach(span => {
      const sibName = span.getAttribute('data-sib-tag'); // already uppercased
      const inList  = verifiedStoryNames.has(sibName);
      const eligible = inList && eligibleNames.has(sibName);
      if (inList && eligible) {
        span.style.color = '#34d399';
        span.textContent = '● eligible';
      } else if (inList) {
        const warn = storyWarningMap.get(sibName);
        if (warn?.status === 'In Progress' && warn?.name) {
          span.style.color = '#f59e0b';
          span.textContent = `● In Progress — ${warn.name}`;
        } else {
          span.style.color = '#f87171';
          span.textContent = '● not eligible';
        }
      } else {
        span.style.color = '#475569';
        span.textContent = '● not in list';
      }
    });

    if (cleanStories.length > 0) {
      updatePromoteCount();
      document.getElementById('promote-section').style.display = 'block';
      document.getElementById('promoteBtn').disabled = false;
      setStatus('success', `Verification complete — ${cleanStories.length} stor${cleanStories.length === 1 ? 'y' : 'ies'} eligible to promote.`);
    } else {
      // No eligible stories — but show re-verify button if any force stories exist
      if (forcePromoStoryNames.size > 0) {
        document.getElementById('promote-section').style.display = 'block';
        document.getElementById('reVerifyForceWrap').style.display = 'block';
      }
      const forceMsg = forcePromoStoryNames.size > 0
        ? ` (${forcePromoStoryNames.size} stor${forcePromoStoryNames.size === 1 ? 'y' : 'ies'} require force promote)`
        : '';
      setStatus('warning', `Verification complete — no eligible stories to promote.${forceMsg}`);
    }
  }

  else if (msg.type === 'promote-result') {
    const errMsg = msg.success ? null : (msg.error || 'Unknown error');
    upsertRow(msg.storyName, '', null, null,
      errMsg ? [{ sha: 'promote-error', coveredComponents: [], uncoveredComponents: [], authorMismatch: false, orphaned: false, _errorMsg: errMsg }] : null,
      msg.success ? 'promoted' : 'promote-failed', null, null);
    if (!msg.success) {
      setStatus('error', `Promote failed: ${errMsg}`);
    }
    // Remove successfully promoted story so count stays accurate for remaining eligible stories
    if (msg.success) {
      const idx = cleanStories.findIndex(s => s.name === msg.storyName);
      if (idx !== -1) cleanStories.splice(idx, 1);
    }
  }

  else if (msg.type === 'promote-summary') {
    const successes = (msg.promotionSummary || []).filter(p => p.success);
    const total = successes.length;
    if (total === 0) return; // individual errors already shown

    // Destination env line
    const byEnv = {};
    for (const p of successes) {
      const env = p.destEnvName || 'Unknown';
      byEnv[env] = (byEnv[env] || 0) + 1;
    }
    const envEntries = Object.entries(byEnv);
    const envLine = envEntries.length === 1
      ? `${total} Promotion${total > 1 ? 's' : ''} created to ${envEntries[0][0]}`
      : `${total} Promotions created — ${envEntries.map(([e, c]) => `${c} to ${e}`).join(', ')}`;

    // Promotion names line
    const names = successes.map(p => p.promotionName).filter(Boolean);
    const namesLine = names.length > 0 ? `Promotions Created: ${names.join(', ')}` : '';

    // Merge & Deploy status line
    let mdLine = '';
    if (mergeDeployResults.length > 0) {
      const mdOk  = mergeDeployResults.filter(r => r.success);
      const mdErr = mergeDeployResults.filter(r => !r.success);
      if (mdErr.length === 0) {
        mdLine = `Merge & Deploy triggered for all ${mdOk.length} promotion${mdOk.length > 1 ? 's' : ''}.`;
      } else if (mdOk.length > 0) {
        const uniqueErrs = [...new Set(mdErr.map(r => r.error))];
        mdLine = `Merge & Deploy: ${mdOk.length} triggered, ${mdErr.length} failed — ${uniqueErrs.join('; ')}`;
      } else {
        const uniqueErrs = [...new Set(mdErr.map(r => r.error))];
        mdLine = `Merge & Deploy failed: ${uniqueErrs.join('; ')}`;
      }
    }

    const allMdFailed = mergeDeployResults.length > 0 && mergeDeployResults.every(r => !r.success);
    const bar = document.getElementById('statusBar');
    bar.style.display = 'flex';
    bar.className = allMdFailed ? 'status-bar error' : 'status-bar success';
    bar.innerHTML = `<span>${envLine}${namesLine ? `<br><span style="font-size:11px;opacity:0.85">${namesLine}</span>` : ''}${mdLine ? `<br><span style="font-size:11px;opacity:0.85">${mdLine}</span>` : ''}</span>`;
  }

  else if (msg.type === 'merge-deploy-started') {
    mergeDeployResults.push({ success: true, promotionId: msg.promotionId, jobId: msg.jobExecutionId });
  }

  else if (msg.type === 'merge-deploy-error') {
    mergeDeployResults.push({ success: false, promotionId: msg.promotionId, error: msg.error });
  }

  else if (msg.type === 'process-exit') {
    if (msg.code !== 0 && !runCompleted) {
      setStatus('error', `Process exited with code ${msg.code}. Check org connectivity and try again.`);
      endRun();
    }
  }
});
