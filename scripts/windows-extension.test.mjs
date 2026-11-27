import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWindowsExtension } from './windows-extension.mjs';
import { contentScriptsFor, rulesetsFor } from '../windows/site-groups.js';

const allSites = ['*://*.youtube.com/*', '*://*.pornhub.com/*', '*://*.xvideos.com/*', '*://*.xhamster.com/*', '*://*.xnxx.com/*'];
const manifest = {
    name: 'test',
    permissions: ['scripting', 'declarativeNetRequest'],
    content_scripts: [
        { matches: allSites, js: ['scriptlets/main/ublock-filters.js'], run_at: 'document_start', all_frames: false, world: 'MAIN' },
        {
            matches: allSites,
            js: ['scriptlets/isolated/ublock-filters.js'],
            run_at: 'document_start',
            all_frames: false,
            world: 'ISOLATED',
        },
    ],
};

test('the Windows manifest moves content scripts out and adds storage', () => {
    const { manifest: windows, contentScripts } = buildWindowsExtension(manifest);
    assert.equal(windows.content_scripts, undefined);
    assert.deepEqual(windows.permissions, ['scripting', 'declarativeNetRequest', 'storage']);
    assert.deepEqual(contentScripts, manifest.content_scripts);
});

test('storage is not added twice', () => {
    const { manifest: windows } = buildWindowsExtension({ ...manifest, permissions: ['storage'] });
    assert.deepEqual(windows.permissions, ['storage']);
});

test('each group registers the scripts for its own sites only', () => {
    const scripts = contentScriptsFor({ youtube: true, videoSites: true }, manifest.content_scripts);
    assert.deepEqual(
        scripts.map((s) => [s.id, s.matches, s.world]),
        [
            ['youtube-0', ['*://*.youtube.com/*'], 'MAIN'],
            ['youtube-1', ['*://*.youtube.com/*'], 'ISOLATED'],
            ['videoSites-0', allSites.slice(1), 'MAIN'],
            ['videoSites-1', allSites.slice(1), 'ISOLATED'],
        ],
    );
    assert.equal(scripts[0].runAt, 'document_start');
});

test('a group that is off registers nothing', () => {
    assert.deepEqual(
        contentScriptsFor({ youtube: false, videoSites: true }, manifest.content_scripts).map((s) => s.id),
        ['videoSites-0', 'videoSites-1'],
    );
    assert.deepEqual(contentScriptsFor({ youtube: false, videoSites: false }, manifest.content_scripts), []);
});

test('the YouTube ruleset follows the YouTube group', () => {
    assert.deepEqual(rulesetsFor({ youtube: true }), { enableRulesetIds: ['youtube'], disableRulesetIds: [] });
    assert.deepEqual(rulesetsFor({ youtube: false, videoSites: true }), { enableRulesetIds: [], disableRulesetIds: ['youtube'] });
});
