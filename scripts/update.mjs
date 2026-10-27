import fs from 'fs';
import { mergeContentScripts } from './merge-content-scripts.mjs';
import { pruneScriptlet } from './prune-scriptlet.mjs';

const includeExperimentalScriptlets = false;
const includeLists = ['ublock-filters', 'ublock-experimental'];
const includeHosts = ['www.youtube.com', 'youtube.com', 'tv.youtube.com', 'm.youtube.com', 'music.youtube.com'];
// scriptlets are pruned to includeHosts, so only inject them on those sites
const includeMatches = includeHosts.map((host) => `https://${host}/*`);
const uBOLRef = 'refs/heads/main';
const rulesetsPath = 'chromium/rulesets';
const uBOLBaseURL = `https://raw.githubusercontent.com/uBlockOrigin/uBOL-home/${uBOLRef}/${rulesetsPath}`;

/** @type {Map<string, Promise<string>>} */
const fetchCache = new Map();

/**
 * Fetch a file from the uBOL rulesets, once per run.
 * @param {string} path relative to the rulesets directory
 * @returns {Promise<string>}
 */
function fetchRuleset(path) {
    if (!fetchCache.has(path)) {
        fetchCache.set(
            path,
            fetch(`${uBOLBaseURL}/${path}`).then((response) => {
                if (!response.ok) {
                    throw new Error(`Failed to fetch ${path}: ${response.status}`);
                }
                return response.text();
            }),
        );
    }
    return fetchCache.get(path);
}

(async () => {
    // fetch scriptlets and filter for included filter lists
    console.log('[Fetch scriptlet-details.json]');
    const scriptletDetails = JSON.parse(await fetchRuleset('scriptlet-details.json'));
    console.log(` - Available filter lists: ${scriptletDetails.map((pair) => pair[0]).join(', ')}`);
    console.log(` - Selected filter lists: ${includeLists.join(', ')}`);
    const contentScripts = [];
    for (const [list, scriptlets] of scriptletDetails) {
        if (!includeLists.includes(list)) {
            continue;
        }

        for (const context of Object.keys(scriptlets)) {
            if (scriptlets[context][0] !== '*' && scriptlets[context][0] !== 'www.youtube.com') {
                console.warn(`Skipping scriptlet ${list} for context ${context}: only wildcard is supported`);
                continue;
            }
            const contextDir = context.toLowerCase();
            const scriptletName = `${contextDir}/${list}.js`;
            console.log(`[Fetch ${scriptletName}]`);
            fs.mkdirSync(`src/rulesets/scripting/scriptlet/${contextDir}`, { recursive: true });
            if (list !== 'ublock-experimental' || includeExperimentalScriptlets) {
                const [begin, ruleset, end] = await Promise.all(
                    ['scriptlet-begin', list, 'scriptlet-end'].map((name) => fetchRuleset(`scripting/scriptlet/${contextDir}/${name}.js`)),
                );
                fs.writeFileSync(`src/scriptlets/${scriptletName}`, pruneScriptlet({ begin, ruleset, end }, includeHosts));
            } else {
                fs.writeFileSync(`src/scriptlets/${scriptletName}`, '');
            }
            contentScripts.push({
                matches: includeMatches,
                js: [`scriptlets/${scriptletName}`],
                all_frames: false,
                run_at: 'document_start',
                world: context,
            });
        }
    }
    const manifest = JSON.parse(fs.readFileSync(`src/manifest.json`, 'utf8'));
    manifest.content_scripts = mergeContentScripts(contentScripts, manifest.content_scripts);
    manifest.version = new Date()
        .toISOString()
        .slice(0, 10)
        .split('-')
        .map((v) => parseInt(v, 10))
        .join('.');
    fs.writeFileSync(`src/manifest.json`, JSON.stringify(manifest, null, 4));
    console.log(`[Updated manifest.json with ${manifest.content_scripts.length} content scripts]`);
})();
