import vm from 'node:vm';

const sectionSeparator = '/******************************************************************************/';

/**
 * Matches the inline data arrays in uBOL generated scriptlet files, e.g.
 *     const scriptletHostnames = /* 13987 *\/ ["*","edu",...];
 *     scriptletGlobals.functionRefs = /* 59 *\/ [trustedEditInboundObject,adjustSetTimeout,...];
 * @param {string} target left hand side of the assignment
 */
const arrayDeclaration = (target) => new RegExp(`(${target.replace(/[.$]/g, '\\$&')} = )/\\* \\d+ \\*/ \\[(.*)\\];`);

const jsonItems = {
    parse: (items) => JSON.parse(`[${items}]`),
    serialize: (values) => JSON.stringify(values).slice(1, -1),
};
const identifierItems = {
    parse: (items) => items.split(','),
    serialize: (values) => values.join(','),
};

/**
 * @param {string} source
 * @param {string} target
 * @param {typeof jsonItems} items
 * @returns {any[]}
 */
export function readArray(source, target, items = jsonItems) {
    const match = source.match(arrayDeclaration(target));
    if (!match) {
        throw new Error(`Could not find ${target} in scriptlet`);
    }
    return items.parse(match[2]);
}

/**
 * @param {string} source
 * @param {string} target
 * @param {any[]} values
 * @param {typeof jsonItems} items
 * @returns {string}
 */
function writeArray(source, target, values, items = jsonItems) {
    readArray(source, target, items);
    return source.replace(arrayDeclaration(target), (_, decl) => `${decl}/* ${values.length} */ [${items.serialize(values)}];`);
}

/**
 * Keep only the entries of arr at the given indices. Other entries are blanked rather than removed so
 * that indices are preserved, and the array is truncated after the last kept entry.
 * @param {any[]} arr
 * @param {Set<number>} keep
 * @returns {any[]}
 */
function keepIndices(arr, keep) {
    return arr.slice(0, Math.max(-1, ...keep) + 1).map((v, i) => (keep.has(i) ? v : ''));
}

/**
 * Read the $SECRET_ID$ that a uBOL scriptlet file's local scope is invoked with.
 * @param {string} source
 * @returns {string}
 */
function secretId(source) {
    const match = source.match(/^}\)\("([^"]+)"\);$/m);
    if (!match) {
        throw new Error('Could not find secret ID in scriptlet');
    }
    return match[1];
}

/**
 * Strip the leading license comment from a scriptlet file.
 * @param {string} source
 * @returns {string}
 */
function stripHeader(source) {
    if (!source.startsWith('/*')) {
        throw new Error('Expected scriptlet to start with a license comment');
    }
    return source.slice(source.indexOf('*/') + 2);
}

/**
 * Prune a ruleset scriptlet (e.g. ublock-filters.js) to only include hosts in includeHosts.
 *
 * Indices into arglists and args are preserved (see keepIndices), so references between them
 * stay valid.
 * @param {string} scriptlet ruleset scriptlet contents
 * @param {string[]} includeHosts list of hosts whose scriptlets should be kept
 * @returns {{ source: string, functionIndices: Set<number> }} pruned scriptlet, and the indices
 *   into scriptletGlobals.functionRefs it uses
 */
function pruneRuleset(scriptlet, includeHosts) {
    const scriptletHostnames = readArray(scriptlet, 'const scriptletHostnames');
    const scriptletArglistRefs = readArray(scriptlet, 'const arglistRefs');
    const scriptletArglists = readArray(scriptlet, 'const arglists');
    const scriptletArgs = readArray(scriptlet, 'const args');

    // hostnames are sorted for a binary search in the scriptlet: filtering keeps that order, and
    // arglistRefs are aligned with hostnames so we filter them the same way.
    const keepHost = scriptletHostnames.map((hn) => includeHosts.includes(hn));
    const newScriptletHostnames = scriptletHostnames.filter((_, i) => keepHost[i]);
    const newScriptletArglistRefs = scriptletArglistRefs.filter((_, i) => keepHost[i]);

    // Negative refs are exceptions (~ref) and don't point directly at an arglist.
    const arglistIndices = new Set(newScriptletArglistRefs.flatMap((refs) => JSON.parse(`[${refs}]`)).filter((ref) => ref >= 0));
    // Arglist 0 is a sentinel used to disable all scriptlets, keep it as is.
    arglistIndices.add(0);
    const newScriptletArglists = keepIndices(scriptletArglists, arglistIndices);

    // Arglists are "functionIndex,argIndex,argIndex,..."
    const arglists = newScriptletArglists.filter(Boolean).map((a) => a.split(',').map(Number));
    const functionIndices = new Set(arglists.map((a) => a[0]));
    const argIndices = new Set(arglists.flatMap((a) => a.slice(1)));

    let source = scriptlet;
    source = writeArray(source, 'const scriptletHostnames', newScriptletHostnames);
    source = writeArray(source, 'const arglistRefs', newScriptletArglistRefs);
    source = writeArray(source, 'const arglists', newScriptletArglists);
    source = writeArray(source, 'const args', keepIndices(scriptletArgs, argIndices));
    // Regex hostname matching is not needed for our included hosts.
    source = writeArray(source, 'const scriptletFromRegexes', []);
    const hasRegexes = /^const \$hasRegexes\$ = (?:true|false);$/m;
    if (!hasRegexes.test(source)) {
        throw new Error('Could not find $hasRegexes$ in scriptlet');
    }
    source = source.replace(hasRegexes, 'const $hasRegexes$ = false;');
    return { source, functionIndices };
}

/**
 * Prune the scriptlet framework (scriptlet-begin.js) to only include the scriptlet functions in
 * functionIndices, and any functions or classes they depend on.
 * @param {string} begin scriptlet-begin.js contents
 * @param {Set<number>} functionIndices indices into scriptletGlobals.functionRefs to keep
 * @param {string} ruleset pruned ruleset scriptlet that will run with this framework
 * @returns {string} pruned framework contents
 */
function pruneFramework(begin, functionIndices, ruleset) {
    const sections = begin.split(sectionSeparator);
    if (sections.length !== 5) {
        throw new Error(`Unexpected scriptlet-begin.js format: ${sections.length} sections`);
    }
    const [header, globals, declarations, refs, footer] = sections;

    // functionRefs is aligned with the function index in arglists.
    const functionRefs = readArray(refs, 'scriptletGlobals.functionRefs', identifierItems);
    const newRefs = writeArray(refs, 'scriptletGlobals.functionRefs', keepIndices(functionRefs, functionIndices), identifierItems);

    // The declarations section is a list of unindented top level function and class declarations:
    // each runs until the next one starts.
    const starts = [...declarations.matchAll(/^(?:function|class) ([\w$]+)\b/gm)];
    const sources = new Map(starts.map((m, i) => [m[1], declarations.slice(m.index, starts[i + 1]?.index).trimEnd()]));

    // Keep declarations reachable from the functionRefs and the ruleset.
    const patterns = new Map([...sources.keys()].map((name) => [name, new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`)]));
    const kept = new Set();
    const pending = [newRefs, ruleset];
    while (pending.length > 0) {
        const code = pending.pop();
        for (const [name, pattern] of patterns) {
            if (!kept.has(name) && pattern.test(code)) {
                kept.add(name);
                pending.push(sources.get(name));
            }
        }
    }
    const newDeclarations = `\n\n${[...sources.keys()]
        .filter((name) => kept.has(name))
        .map((name) => sources.get(name))
        .join('\n\n')}\n\n`;

    return [header, globals, newDeclarations, newRefs, footer].join(sectionSeparator);
}

/**
 * Build a self-contained, pruned scriptlet for a ruleset. uBOL splits scriptlets into a shared
 * framework (scriptlet-begin.js) which declares the scriptlet functions, ruleset files which select
 * which scriptlets to run for a hostname, and scriptlet-end.js which cleans up. We combine these
 * into a single file, pruned to only include hosts in includeHosts.
 * @param {{ begin: string, ruleset: string, end: string }} scriptlets contents of each uBOL file
 * @param {string[]} includeHosts list of hosts whose scriptlets should be kept
 * @returns {string} pruned scriptlet contents
 */
export function pruneScriptlet({ begin, ruleset, end }, includeHosts) {
    const ids = new Set([begin, ruleset, end].map(secretId));
    if (ids.size !== 1) {
        throw new Error(`Scriptlet files are from different uBOL builds: ${[...ids].join(', ')}`);
    }

    const { source: newRuleset, functionIndices } = pruneRuleset(ruleset, includeHosts);
    const newBegin = pruneFramework(begin, functionIndices, newRuleset);

    // Update copyright header
    const header = newBegin.replace('\n', '\n    Copyright (C) 2026 Duck Duck Go, Inc.\n    Modified from the original source:\n');
    const output = [header, stripHeader(newRuleset), stripHeader(end)].join('\n');
    // Fail the update rather than ship a scriptlet that does not parse.
    // eslint-disable-next-line no-new
    new vm.Script(output);
    return output;
}
