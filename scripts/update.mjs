import fs from 'fs';
import { pruneScriptlet } from './prune-scriptlet.mjs';

const includeExperimentalScriptlets = false;
const includeLists = ['ublock-filters', 'ublock-experimental'];
const includeHosts = ['www.youtube.com', 'youtube.com', 'tv.youtube.com', 'm.youtube.com', 'music.youtube.com'];
const uBOLRef = 'refs/heads/main';
const rulesetsPath = 'chromium/rulesets';
const uBOLBaseURL = `https://raw.githubusercontent.com/uBlockOrigin/uBOL-home/${uBOLRef}/${rulesetsPath}`;

(async () => {
    // fetch scriptlets and filter for included filter lists
    console.log('[Fetch scriptlet-details.json]');
    const scriptletDetails = await (await fetch(`${uBOLBaseURL}/scriptlet-details.json`)).json();
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
            const scriptletName = `${context.toLowerCase()}/${list}.js`;
            console.log(`[Fetch ${scriptletName}]`);
            fs.mkdirSync(`src/rulesets/scripting/scriptlet/${context.toLowerCase()}`, { recursive: true });
            if (list !== 'ublock-experimental' || includeExperimentalScriptlets) {
                fs.writeFileSync(
                    `src/scriptlets/${scriptletName}`,
                    pruneScriptlet(await (await fetch(`${uBOLBaseURL}/scripting/scriptlet/${scriptletName}`)).text(), includeHosts),
                );
            } else {
                fs.writeFileSync(`src/scriptlets/${scriptletName}`, '');
            }
            contentScripts.push({
                matches: ['<all_urls>'],
                js: [`scriptlets/${scriptletName}`],
                all_frames: true,
                match_origin_as_fallback: true,
                run_at: 'document_start',
                world: context,
            });
        }
    }
    const manifest = JSON.parse(fs.readFileSync(`src/manifest.json`, 'utf8'));
    manifest.content_scripts = contentScripts;
    manifest.version = new Date()
        .toISOString()
        .slice(0, 10)
        .split('-')
        .map((v) => parseInt(v, 10))
        .join('.');
    fs.writeFileSync(`src/manifest.json`, JSON.stringify(manifest, null, 4));
    console.log(`[Updated manifest.json with ${contentScripts.length} content scripts]`);
})();
