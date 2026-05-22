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
  }