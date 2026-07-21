import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { pruneScriptlet } from './prune-scriptlet.mjs';

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/minimal-scriptlet.js');
const fixture = readFileSync(fixturePath, 'utf8');
const includeHosts = ['youtube.com', 'www.youtube.com'];

test('pruneScriptlet output is valid JavaScript', () => {
    const pruned = pruneScriptlet(fixture, includeHosts);

    assert.doesNotThrow(() => new vm.Script(pruned), 'pruned scriptlet should parse');

    const hostnamesMatch = /const \$scriptletHostnames\$ = \/\* \d+ \*\/ (\[[\s\S]*?\]);/.exec(pruned);
    assert.ok(hostnamesMatch, 'expected $scriptletHostnames$ declaration');
    assert.deepEqual(JSON.parse(hostnamesMatch[1]), includeHosts);

    assert.doesNotMatch(pruned, /drop\.example/);
});
