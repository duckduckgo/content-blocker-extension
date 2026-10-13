import vm from 'node:vm';

const sectionSeparator = '/******************************************************************************/';

/**
 * Matches the inline data arrays in uBOL generated scriptlet files, e.g.
 *     const scriptletHostnames = /* 13987 *\/ ["*","edu",...];
 * @param {string} name
 */
const arrayDeclaration = (name) => new RegExp(`(const ${name} = )/\\* \\d+ \\*/ (\\[.*\\]);`);

/**
 * @param {string} source
 * @param {string} name
 * @returns {any[]}
 */
function readArray(source, name) {
    const match = source.match(arrayDeclaration(name));
    if (!match) {
        throw new Error(`Could not find array ${name} in scriptlet`);
    }
    return JSON.parse(match[2]);
}

/**
 * @param {string} source
 * @param {string} name
 * @param {any[]} values
 * @returns {string}
 */
function writeArray(source, name, values) {
    return source.replace(arrayDeclaration(name), (_, decl) => `${decl}/* ${values.length} */ ${JSON.stringify(values)};`);
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
    return source.slice(source.indexOf('*/') + 2);
}

/**
 * Prune a ruleset scriptlet (e.g. ublock-filters.js) to only include hosts in includeHosts.
 *
 * Indices into scriptletHostnames, arglists and args are preserved (unused entries are blanked
 * and the arrays truncated after the last used entry), so references between them stay valid.
 * @param {string} scriptlet ruleset scriptlet contents
 * @param {string[]} includeHosts list of hosts whose scriptlets should be kept
 * @returns {{ source: string, functionIndices: Set<number> }} pruned scriptlet, and the indices
 *   into scriptletGlobals.functionRefs it uses
 */
function pruneRuleset(scriptlet, includeHosts) {
    const scriptletHostnames = readArray(scriptlet, 'scriptletHostnames');
    const scriptletArglistRefs = readArray(scriptlet, 'arglistRefs');
    const scriptletArglists = readArray(scriptlet, 'arglists');
    const scriptletArgs = readArray(scriptlet, 'args');

    // hostnames are sorted for a binary search in the scriptlet: filtering keeps that order, and
    // arglistRefs are aligned with hostnames so we filter them the same way.
    const indices = scriptletHostnames.reduce((acc, hn, i) => {
        if (includeHosts.includes(hn)) {
            acc.push(i);
        }
        return acc;
    }, []);
    const newScriptletHostnames = indices.map((i) => scriptletHostnames[i]);
    const newScriptletArglistRefs = indices.map((i) => scriptletArglistRefs[i]);

    // Negative refs are exceptions (~ref) and don't point directly at an arglist.
    const arglistIndices = new Set(
        newScriptletArglistRefs
            .map((refs) => JSON.parse(`[${refs}]`))
            .flat()
            .filter((ref) => ref >= 0),
    );
    // Arglist 0 is a sentinel used to disable all scriptlets, keep it as is.
    arglistIndices.add(0);
    const newScriptletArglists = scriptletArglists
        .slice(0, Math.max(...arglistIndices) + 1)
        .map((v, i) => (arglistIndices.has(i) ? v : ''));

    // Arglists are "functionIndex,argIndex,argIndex,..."
    const arglists = [...arglistIndices].filter((i) => scriptletArglists[i] !== '').map((i) => scriptletArglists[i].split(',').map(Number));
    const functionIndices = new Set(arglists.map((a) => a[0]));
    const argIndices = new Set(arglists.flatMap((a) => a.slice(1)));
    const newScriptletArgs = scriptletArgs.slice(0, Math.max(...argIndices) + 1).map((v, i) => (argIndices.has(i) ? v : ''));

    let source = scriptlet;
    source = writeArray(source, 'scriptletHostnames', newScriptletHostnames);
    source = writeArray(source, 'arglistRefs', newScriptletArglistRefs);
    source = writeArray(source, 'arglists', newScriptletArglists);
    source = writeArray(source, 'args', newScriptletArgs);
    // Regex hostname matching is not needed for our included hosts.
    source = writeArray(source, 'scriptletFromRegexes', []);
    source = source.replace(/^const \$hasRegexes\$ = true;$/m, 'const $hasRegexes$ = false;');
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

    // functionRefs is aligned with the function index in arglists: blank unused entries so that
    // indices are unchanged.
    const functionRefsDeclaration = /(scriptletGlobals\.functionRefs = )\/\* \d+ \*\/ \[(.*)\];/;
    const functionRefsMatch = refs.match(functionRefsDeclaration);
    if (!functionRefsMatch) {
        throw new Error('Could not find scriptletGlobals.functionRefs in scriptlet-begin.js');
    }
    const functionRefs = functionRefsMatch[2].split(',');
    const newFunctionRefs = functionRefs.slice(0, Math.max(...functionIndices) + 1).map((v, i) => (functionIndices.has(i) ? v : ''));
    const newRefs = refs.replace(
        functionRefsDeclaration,
        (_, decl) => `${decl}/* ${newFunctionRefs.length} */ [${newFunctionRefs.join(',')}];`,
    );

    // The declarations section is a list of top level function and class declarations. Repeatedly
    // drop any that are no longer referenced by the remaining code.
    const context = vm.createContext({});
    vm.runInContext(declarations, context);
    const names = [...declarations.matchAll(/^(?:function|class) ([\w$]+)\b/gm)].map((m) => m[1]);
    const sources = new Map(names.map((name) => [name, vm.runInContext(`${name}.toString()`, context)]));
    for (const [name, source] of sources) {
        if (!declarations.includes(source)) {
            throw new Error(`Could not locate declaration of ${name} in scriptlet-begin.js`);
        }
    }
    const kept = new Set(names);
    const isReferenced = (name) => {
        const pattern = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`);
        const otherCode = [newRefs, ruleset, ...[...kept].filter((n) => n !== name).map((n) => sources.get(n))];
        return otherCode.some((code) => pattern.test(code));
    };
    let changed = true;
    while (changed) {
        changed = false;
        for (const name of kept) {
            if (!isReferenced(name)) {
                kept.delete(name);
                changed = true;
            }
        }
    }
    const newDeclarations = `\n\n${[...kept].map((name) => sources.get(name)).join('\n\n')}\n\n`;

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
    const headerLines = newBegin.split('\n');
    headerLines.splice(1, 0, [
        `    Copyright (C) 2026 Duck Duck Go, Inc.
    Modified from the original source:`,
    ]);
    return [headerLines.join('\n'), stripHeader(newRuleset), stripHeader(end)].join('\n');
}
