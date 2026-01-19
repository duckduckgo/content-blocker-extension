import { VM } from 'vm2';

const sectionSeparator = '/******************************************************************************/';

/**
 * Prune a scriptlet to only include hosts in the includeHosts list.
 * @param {string} scriptlet contents
 * @param {stringp[]} hosts list of hosts whose scriptlets should be kept
 * @returns {string} pruned scriptlet contents
 */
export function pruneScriptlet(scriptlet, includeHosts) {
    const scriptletSections = scriptlet.split(sectionSeparator);
    const [header, functions, vars, execute, footer] = scriptletSections;

    const vm = new VM();
    vm.run(functions);
    vm.run(vars);
    const scriptletFunctions = vm.run('Array.isArray($scriptletFunctions$) ? $scriptletFunctions$.map(f => f.name) : []');
    const fullScriptletFunctions = vm.run('Array.isArray($scriptletFunctions$) ? $scriptletFunctions$ : []');
    const scriptletArgs = vm.run(
        'Array.isArray($scriptletArgs$) && $scriptletArgs$.every(h => typeof h === "string") ? $scriptletArgs$ : []',
    );
    const scriptletArglists = vm.run('typeof $scriptletArglists$ === "string" ? $scriptletArglists$.split(";") : []');
    const scriptletArglistRefs = vm.run('typeof $scriptletArglistRefs$ === "string" ? $scriptletArglistRefs$.split(";") : []');
    const scriptletHostnames = vm.run(
        'Array.isArray($scriptletHostnames$) && $scriptletHostnames$.every(h => typeof h === "string") ? $scriptletHostnames$ : []',
    );

    // find indices of hostnames in includeHosts
    const indices = scriptletHostnames.reduce((acc, hn, i) => {
        if (includeHosts.includes(hn)) {
            acc.push(i);
        }
        return acc;
    }, []);
    // hostname indicies are aligned with arglistrefs we can safely drop all entries not matching our included hosts.
    const newScriptletHostnames = scriptletHostnames.filter((_, i) => indices.includes(i));
    const newScriptletArglistRefs = scriptletArglistRefs.filter((_, i) => indices.includes(i)).join(';');

    // We can consult arglistrefs for each host to get the arglist indices we need to keep.
    const arglistRefs = indices.map((i) => JSON.parse(`[${scriptletArglistRefs[i]}]`));
    const arglistIndices = new Set(arglistRefs.flat());

    // When pruning arglists, we need to preserve indices to avoid having to rebuild arglistRefs. We can
    // drop all entries after the highest arglist index and replace all unreferenced entries with empty strings.
    const newScriptletArglists = scriptletArglists
        .slice(0, Math.max(...arglistIndices.values()) + 1)
        .map((v, i) => (arglistIndices.has(i) ? v : ''))
        .join(';');

    const argIndices = new Set(
        scriptletArglists
            .filter((_, i) => arglistIndices.has(i))
            .map((a) => a.split(',').map(Number))
            .map((a) => a.slice(1))
            .flat(),
    );
    const arglists = scriptletArglists.filter((_, i) => arglistIndices.has(i)).map((a) => a.split(',').map(Number));
    const functionIndices = new Set(arglists.map((a) => a[0]));

    // We can apply the same logic to args. We can also prune args by dropping all entries after the highest arg index.
    const newScriptletArgs = scriptletArgs.slice(0, Math.max(...argIndices) + 1).map((v, i) => (argIndices.has(i) ? v : ''));
    const newScriptletFunctions = scriptletFunctions
        .slice(0, Math.max(...functionIndices) + 1)
        .map((v, i) => (functionIndices.has(i) ? v : ''));

    const newVars = `

const scriptletGlobals = {}; // eslint-disable-line

const $scriptletFunctions$ = [
${newScriptletFunctions.join(',\n')}
];

const $scriptletArgs$ = ${JSON.stringify(newScriptletArgs, null, 2)};

const $scriptletArglists$ = "${newScriptletArglists}";

const $scriptletArglistRefs$ = "${newScriptletArglistRefs}";

const $scriptletHostnames$ = ${JSON.stringify(newScriptletHostnames, null, 2)};

const $scriptletFromRegexes$ = [];

const $hasEntities$ = true;
const $hasAncestors$ = true;
const $hasRegexes$ = false;

`;
    // Drop unused functions from the functions section of the scriptlet.
    const newFunctions = fullScriptletFunctions
        .filter((_, i) => !functionIndices.has(i))
        .reduce((acc, f, i) => {
            if (acc.includes(f.toString())) {
                return acc.replace(`${f.toString()}\n\n`, '');
            }
            return acc;
        }, functions);

    // Update copyright header
    const headerLines = header.split('\n');
    headerLines.splice(1, 0, [
        `    Copyright (C) 2026 Duck Duck Go, Inc.
    Modified from the original source:`,
    ]);
    return [headerLines.join('\n'), newFunctions, newVars, execute, footer].join(sectionSeparator);
}
