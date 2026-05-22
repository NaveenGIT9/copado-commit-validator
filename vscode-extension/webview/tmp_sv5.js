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
})