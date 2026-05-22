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

})