(function() {
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
})