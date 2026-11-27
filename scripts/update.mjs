import fs from 'fs';
import { mergeContentScripts } from './merge-content-scripts.mjs';
import { pruneScriptlet } from './prune-scriptlet.mjs';

const sourceList = 'ublock-filters';
// The apps accept only these two file names, so ublock-experimental.js carries the experiment sites rather than uBO's experimental list.
const outputs = [
    {
        file: 'ublock-filters',
        hosts: ['www.youtube.com', 'youtube.com', 'tv.youtube.com', 'm.youtube.com', 'music.youtube.com'],
        matches: ['*://*.youtube.com/*'],
        withCustomScriptlets: false,
    },
    {
        file: 'ublock-experimental',
        hosts: ['pornhub.com', 'pornhub.*', 'xvideos.com', 'xvideos.*', 'xhamster.com', 'xhamster.*', 'xnxx.*'],
        matches: ['*://*.pornhub.com/*', '*://*.xvideos.com/*', '*://*.xhamster.com/*', '*://*.xnxx.com/*'],
        withCustomScriptlets: true,
    },
];
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

/**
 * Our own scriptlets for one world, appended to the generated ublock-experimental bundle because the
 * apps only accept the existing scriptlet file names. Each must check its own hostname.
 * @param {string} contextDir 'main' or 'isolated'
 * @returns {string}
 */
function readCustomScriptlets(contextDir) {
    const dir = `src/custom-scriptlets/${contextDir}`;
    if (!fs.existsSync(dir)) {
        return '';
    }
    return fs
        .readdirSync(dir)
        .filter((name) => name.endsWith('.js'))
        .sort()
        .map((name) => `\n${fs.readFileSync(`${dir}/${name}`, 'utf8')}`)
        .join('');
}

(async () => {
    // fetch scriptlets and filter for included filter lists
    console.log('[Fetch scriptlet-details.json]');
    const scriptletDetails = JSON.parse(await fetchRuleset('scriptlet-details.json'));
    console.log(` - Available filter lists: ${scriptletDetails.map((pair) => pair[0]).join(', ')}`);
    console.log(` - Source filter list: ${sourceList}`);
    const scriptlets = Object.fromEntries(scriptletDetails)[sourceList];
    const contentScripts = [];
    for (const output of outputs) {
        for (const context of Object.keys(scriptlets)) {
            if (scriptlets[context][0] !== '*') {
                console.warn(`Skipping ${sourceList} for context ${context}: only wildcard is supported`);
                continue;
            }
            const contextDir = context.toLowerCase();
            const scriptletName = `${contextDir}/${output.file}.js`;
            console.log(`[Build ${scriptletName} from ${sourceList}]`);
            const [begin, ruleset, end] = await Promise.all(
                ['scriptlet-begin', sourceList, 'scriptlet-end'].map((name) =>
                    fetchRuleset(`scripting/scriptlet/${contextDir}/${name}.js`),
                ),
            );
            const custom = output.withCustomScriptlets ? readCustomScriptlets(contextDir) : '';
            fs.writeFileSync(`src/scriptlets/${scriptletName}`, pruneScriptlet({ begin, ruleset, end }, output.hosts) + custom);
            contentScripts.push({
                matches: output.matches,
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
