import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { pruneScriptlet } from './prune-scriptlet.mjs';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/scriptlet');
const fixture = {
    begin: readFileSync(join(fixtureDir, 'scriptlet-begin.js'), 'utf8'),
    ruleset: readFileSync(join(fixtureDir, 'ruleset.js'), 'utf8'),
    end: readFileSync(join(fixtureDir, 'scriptlet-end.js'), 'utf8'),
};
const includeHosts = ['youtube.com', 'www.youtube.com'];

/**
 * Run scriptlet sources in a sandbox as if injected into a page at origin.
 * @param {string[]} sources
 * @param {string} origin
 * @returns {{ calls: any[][], globals: object }} scriptlet calls, and globals left on self
 */
function runScriptlets(sources, origin) {
    const context = vm.createContext({ document: { location: { origin, ancestorOrigins: [] } } });
    context.self = context;
    context.calls = [];
    const before = new Set(Object.keys(context));
    for (const source of sources) {
        vm.runInContext(source, context);
    }
    const globals = Object.keys(context).filter((k) => !before.has(k));
    // Normalize arrays created in the sandbox realm for deepEqual.
    return { calls: JSON.parse(JSON.stringify(context.calls)), globals };
}

test('pruneScriptlet output is valid JavaScript', () => {
    const pruned = pruneScriptlet(fixture, includeHosts);

    assert.doesNotThrow(() => new vm.Script(pruned), 'pruned scriptlet should parse');

    const hostnamesMatch = /const scriptletHostnames = \/\* \d+ \*\/ (\[.*\]);/.exec(pruned);
    assert.ok(hostnamesMatch, 'expected scriptletHostnames declaration');
    assert.deepEqual(JSON.parse(hostnamesMatch[1]), includeHosts);
    assert.doesNotMatch(pruned, /drop\.example/);
});

test('pruneScriptlet keeps scriptlets for included hosts', () => {
    const pruned = pruneScriptlet(fixture, includeHosts);
    const upstream = runScriptlets([fixture.begin, fixture.ruleset, fixture.end], 'https://www.youtube.com');
    const result = runScriptlets([pruned], 'https://www.youtube.com');

    assert.deepEqual(result.calls, [
        ['keepMe', 'keep'],
        ['keepToo', 'keep-too'],
    ]);
    // Upstream additionally runs the generic ("*") scriptlet, which we drop.
    assert.ok(upstream.calls.some(([name]) => name === 'dropped'));
    assert.deepEqual(
        upstream.calls.filter(([name]) => name !== 'dropped'),
        result.calls,
    );
    assert.deepEqual(result.globals, [], 'scriptlet-end should clean up shared state');
});

test('pruneScriptlet drops scriptlets for other hosts', () => {
    const pruned = pruneScriptlet(fixture, includeHosts);
    assert.deepEqual(runScriptlets([pruned], 'https://drop.example').calls, []);
});

test('pruneScriptlet removes unused functions and classes', () => {
    const pruned = pruneScriptlet(fixture, includeHosts);

    for (const name of ['keepMe', 'keepToo', 'helperFn', 'Recorder']) {
        assert.match(pruned, new RegExp(`^(function|class) ${name}\\b`, 'm'), `${name} should be kept`);
    }
    for (const name of ['dropMe', 'dropHelper', 'Unused']) {
        assert.doesNotMatch(pruned, new RegExp(`\\b${name}\\b`), `${name} should be removed`);
    }
    // functionRefs indices must be preserved, as arglists reference them by position.
    assert.match(pruned, /scriptletGlobals\.functionRefs = \/\* 2 \*\/ \[keepMe,keepToo\];/);
});

test('pruneScriptlet rejects files from different uBOL builds', () => {
    const end = fixture.end.replace('fixture-secret-id', 'other-secret-id');
    assert.throws(() => pruneScriptlet({ ...fixture, end }, includeHosts), /different uBOL builds/);
});
