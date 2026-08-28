import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isGeneratedContentScript, mergeContentScripts } from './merge-content-scripts.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(repoRoot, 'src/manifest.json'), 'utf8'));

const generatedEntry = (path, world) => ({
    matches: ['<all_urls>'],
    js: [`scriptlets/${path}`],
    all_frames: true,
    match_origin_as_fallback: true,
    run_at: 'document_start',
    world,
});

test('generated scriptlet entries are recognised by their js path', () => {
    assert.equal(isGeneratedContentScript(generatedEntry('main/ublock-filters.js', 'MAIN')), true);
    assert.equal(isGeneratedContentScript({ js: ['content-scripts/yt-sabr-fix.js'] }), false);
    assert.equal(isGeneratedContentScript({ js: ['scriptlets/main/a.js', 'content-scripts/b.js'] }), false);
});

test('an entry with no js files is preserved rather than dropped', () => {
    assert.equal(isGeneratedContentScript({ matches: ['<all_urls>'], css: ['a.css'] }), false);
    assert.equal(isGeneratedContentScript({ js: [] }), false);
    assert.equal(isGeneratedContentScript(undefined), false);
});

test('regenerating replaces scriptlets and keeps first-party content scripts', () => {
    const existing = [
        generatedEntry('main/ublock-filters.js', 'MAIN'),
        generatedEntry('isolated/ublock-filters.js', 'ISOLATED'),
        { matches: ['*://*.youtube.com/*'], js: ['content-scripts/yt-sabr-fix.js'], world: 'MAIN' },
    ];
    const generated = [generatedEntry('main/ublock-filters.js', 'MAIN')];

    const merged = mergeContentScripts(generated, existing);

    assert.deepEqual(merged, [generated[0], existing[2]]);
});

test.skip('every first-party content script in the manifest survives an update', () => {
    const firstParty = manifest.content_scripts.filter((entry) => !isGeneratedContentScript(entry));
    assert.ok(firstParty.length > 0, 'expected at least one hand-maintained content script');

    // An update that finds no scriptlets at all is the worst case for the entries we maintain.
    const merged = mergeContentScripts([], manifest.content_scripts);

    assert.deepEqual(merged, firstParty);
    assert.ok(
        firstParty.some((entry) => entry.js.includes('content-scripts/yt-sabr-fix.js')),
        'yt-sabr-fix.js should be registered as a first-party content script',
    );
});

test('merge does not mutate its inputs', () => {
    const generated = [generatedEntry('main/ublock-filters.js', 'MAIN')];
    const existing = [{ js: ['content-scripts/yt-sabr-fix.js'] }];

    mergeContentScripts(generated, existing);

    assert.equal(generated.length, 1);
    assert.equal(existing.length, 1);
});
