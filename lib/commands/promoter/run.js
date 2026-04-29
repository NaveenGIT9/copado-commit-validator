import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { simpleGit } from 'simple-git';
class PromoterRun extends SfCommand {
    async run() {
        const { flags } = await this.parse(PromoterRun);
        const storyNames = flags.stories.split(',').map((s) => s.trim()).filter(Boolean);
        const repoPath = flags['repo-path'] ?? process.cwd();
        const doPromote = flags.promote ?? false;
        const conn = flags['target-org'].getConnection();
        const git = simpleGit(repoPath);
        // --- PROMOTE MODE: just flip the flag on pre-verified clean stories ---
        if (doPromote && flags['story-ids']) {
            const ids = flags['story-ids'].split(',').map((s) => s.trim()).filter(Boolean);
            for (const id of ids) {
                const name = storyNames.shift() ?? id;
                try {
                    await conn.sobject('copado__User_Story__c').update({ Id: id, copado__Promote_and_Deploy__c: true });
                    this.emit({ type: 'promote-result', storyName: name, storyId: id, success: true });
                }
                catch (err) {
                    this.emit({ type: 'promote-result', storyName: name, storyId: id, success: false, error: String(err) });
                }
            }
            this.emit({ type: 'done' });
            return;
        }
        // --- VERIFY MODE ---
        this.emit({ type: 'start', storyNames });
        // Step 1: Query all stories from Copado
        const nameList = storyNames.map((n) => `'${n}'`).join(',');
        let stories = [];
        try {
            const result = await conn.query(`SELECT Id, Name, copado__Org_Credential__c, copado__Project__c, copado__Status__c ` +
                `FROM copado__User_Story__c WHERE Name IN (${nameList})`);
            stories = result.records;
        }
        catch (err) {
            this.emit({ type: 'fatal', message: `Copado query failed: ${String(err)}` });
            return;
        }
        // Flag stories not found in org
        const foundNames = new Set(stories.map((r) => r.Name));
        for (const name of storyNames) {
            if (!foundNames.has(name)) {
                this.emit({ type: 'story-error', storyName: name, message: 'Story not found in Copado org' });
            }
        }
        if (stories.length === 0) {
            this.emit({ type: 'fatal', message: 'No stories found. Check story names and org alias.' });
            return;
        }
        // Step 2: Validate same credential + same project
        const credentials = new Set(stories.map((r) => r.copado__Org_Credential__c));
        const projects = new Set(stories.map((r) => r.copado__Project__c));
        if (credentials.size > 1) {
            this.emit({
                type: 'validation-error',
                message: `Credential mismatch — stories belong to ${credentials.size} different org credentials. All stories must share the same credential.`,
            });
            return;
        }
        if (projects.size > 1) {
            this.emit({
                type: 'validation-error',
                message: `Project mismatch — stories belong to ${projects.size} different Copado projects. All stories must be in the same project.`,
            });
            return;
        }
        this.emit({
            type: 'validation-pass',
            credentialId: [...credentials][0],
            projectId: [...projects][0],
        });
        // Step 3: Git fetch to refresh remote refs
        this.emit({ type: 'git-fetch-start' });
        try {
            await git.fetch(['origin']);
        }
        catch (err) {
            this.emit({ type: 'fatal', message: `git fetch failed: ${String(err)}` });
            return;
        }
        this.emit({ type: 'git-fetch-done' });
        // Step 4: Verify each story
        for (const story of stories) {
            const branchName = `feature/${story.Name}`;
            const remoteBranch = `origin/${branchName}`;
            this.emit({ type: 'story-verifying', storyName: story.Name, branch: branchName });
            // 4a: Copado registered commits (status = Complete)
            let copadoCommits = [];
            try {
                const commitResult = await conn.query(`SELECT copado__Snapshot_Commit__r.copado__Commit_Id__c FROM copado__User_Story_Commit__c ` +
                    `WHERE copado__User_Story__c = '${story.Id}' AND copado__Status__c = 'Complete'`);
                copadoCommits = commitResult.records
                    .map((r) => r.copado__Snapshot_Commit__r?.copado__Commit_Id__c?.trim())
                    .filter((h) => Boolean(h));
            }
            catch (err) {
                this.emit({ type: 'story-error', storyName: story.Name, message: `Copado commit query failed: ${String(err)}` });
                continue;
            }
            // 4b: Extra commits on feature branch vs master
            let extraCommits = [];
            try {
                const raw = await git.raw(['log', '--format=%H', `origin/master..${remoteBranch}`]);
                extraCommits = raw.split('\n').map((h) => h.trim()).filter(Boolean);
            }
            catch {
                this.emit({
                    type: 'story-verified',
                    storyName: story.Name,
                    storyId: story.Id,
                    branch: branchName,
                    extraCommits: [],
                    copadoCommits,
                    unregistered: [],
                    verdict: 'error',
                    message: `Remote branch ${remoteBranch} not found. Check if branch exists on origin.`,
                });
                continue;
            }
            // 4c: Cross-reference
            const copadoSet = new Set(copadoCommits);
            const unregistered = extraCommits.filter((h) => !copadoSet.has(h));
            let verdict;
            if (extraCommits.length === 0) {
                verdict = 'skip-no-commits';
            }
            else if (unregistered.length > 0) {
                verdict = 'skip-unregistered';
            }
            else {
                verdict = 'clean';
            }
            this.emit({
                type: 'story-verified',
                storyName: story.Name,
                storyId: story.Id,
                branch: branchName,
                extraCommits,
                copadoCommits,
                unregistered,
                verdict,
            });
        }
        this.emit({ type: 'done' });
    }
    emit(data) {
        process.stdout.write(JSON.stringify(data) + '\n');
    }
}
PromoterRun.summary = 'Verify and promote Copado User Stories';
PromoterRun.enableJsonFlag = false;
PromoterRun.flags = {
    stories: Flags.string({
        char: 's',
        summary: 'Comma-separated User Story names (e.g. US-0023250,US-0023251)',
        required: true,
    }),
    'target-org': Flags.requiredOrg(),
    'repo-path': Flags.string({
        summary: 'Absolute path to local git repository',
        default: process.cwd(),
    }),
    promote: Flags.boolean({
        summary: 'Promote clean stories after verification',
        default: false,
    }),
    'story-ids': Flags.string({
        summary: 'Comma-separated Salesforce IDs of stories to promote (used internally by --promote)',
        required: false,
    }),
};
export default PromoterRun;
//# sourceMappingURL=run.js.map