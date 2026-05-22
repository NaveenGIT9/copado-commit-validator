var msg = {}; var buildRowHtml = () => ""; var verifiedStoryNames = new Set(); var storyWarningMap = new Map(); var forcePromoStoryNames = new Set(); var cleanStories = []; var updatePromoteCount = () => {}; var ensureProjectSection = () => {}; var insertGroupedRow = () => {};
(function() {
if (msg.type === "x") {}
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
})