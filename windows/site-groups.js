/**
 * The Windows browser turns site groups on and off by calling `setSiteGroups` in the service worker.
 * Each group gets the manifest's content scripts limited to its own sites.
 */
export const SITE_GROUPS = {
    youtube: ['youtube.com'],
    videoSites: ['pornhub.com', 'xvideos.com', 'xhamster.com', 'xnxx.com'],
};

export const RULESETS = { youtube: 'youtube' };

// Until the app sets groups, behave like the static manifest did: YouTube only. App versions that never call
// setSiteGroups keep this.
export const DEFAULT_GROUPS = { youtube: true, videoSites: false };

/**
 * @param {string} matchPattern e.g. `*://*.youtube.com/*`
 * @param {string[]} hosts
 */
function matchesHosts(matchPattern, hosts) {
    const host = matchPattern.split('://')[1]?.split('/')[0]?.replace(/^\*\./, '');
    return hosts.includes(host);
}

/**
 * @param {Record<string, boolean>} groups
 * @param {{ js: string[], matches: string[], run_at?: string, all_frames?: boolean, world?: string }[]} manifestContentScripts
 * @returns {chrome.scripting.RegisteredContentScript[]}
 */
export function contentScriptsFor(groups, manifestContentScripts) {
    return Object.entries(SITE_GROUPS)
        .filter(([group]) => groups[group])
        .flatMap(([group, hosts]) =>
            manifestContentScripts.flatMap((entry, i) => {
                const matches = entry.matches.filter((pattern) => matchesHosts(pattern, hosts));
                if (matches.length === 0) {
                    return [];
                }
                return [
                    {
                        id: `${group}-${i}`,
                        matches,
                        js: entry.js,
                        runAt: entry.run_at ?? 'document_idle',
                        allFrames: entry.all_frames ?? false,
                        world: entry.world ?? 'ISOLATED',
                    },
                ];
            }),
        );
}

/**
 * @param {Record<string, boolean>} groups
 */
export function rulesetsFor(groups) {
    const ids = Object.keys(RULESETS);
    return {
        enableRulesetIds: ids.filter((group) => groups[group]).map((group) => RULESETS[group]),
        disableRulesetIds: ids.filter((group) => !groups[group]).map((group) => RULESETS[group]),
    };
}
