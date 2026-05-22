
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