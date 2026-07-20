import { VM } from 'vm2';

const sectionSeparator = '/******************************************************************************/';

const SCRIPTLET_CONST_NAMES = [
    '$scriptletHostnames$',
    '$scriptletArglistRefs$',
    '$scriptletArglists$',
    '$scriptletArgs$',
    '$scriptletFunctions$',
    '$scriptletFromRegexes$',
];

/**
 * Locate `const $name$ = ...;` in source and return its span and text.
 * Upstream emits these as a single line, except `$scriptletFunctions$` which
 * puts the identifier list on the following line after the size comment.
 * @param {string} source
 * @param {string} name
 * @returns {{ start: number, end: number, text: string } | null}
 */
function findConstDeclaration(source, name) {
    const marker = `const ${name} =`;
    const start = source.indexOf(marker);
    if (start === -1) {
        return null;
    }
    let end = source.indexOf('\n', start);
    if (end === -1) {
        end = source.length;
    }
    // `$scriptletFunctions$` is split across two lines: `= /* N */` then `[...]`.
    if (!source.slice(start, end).includes(';')) {
        const nextEnd = source.indexOf('\n', end + 1);
        end = nextEnd === -1 ? source.length : nextEnd;
    }
    return { start, end, text: source.slice(start, end) };
}

/**
 * Prune a scriptlet to only include hosts in the includeHosts list.
 * @param {string} scriptlet contents
 * @param {stringp[]} hosts list of hosts whose scriptlets should be kept
 * @returns {string} pruned scriptlet contents
 */
export function pruneScriptlet(scriptlet, includeHosts) {
    const scriptletSections = scriptlet.split(sectionSeparator);
    const [header, functions, , execute, footer] = scriptletSections;

    // Embedded consts live in the execute section now; lift them to top-level for the VM.
    const decls = Object.fromEntries(SCRIPTLET_CONST_NAMES.map((name) => [name, findConstDeclaration(execute, name)]));
    const vm = new VM();
    vm.run(functions);
    vm.run(
        SCRIPTLET_CONST_NAMES.filter((name) => decls[name])
            .map((name) => decls[name].text)
            .join('\n'),
    );
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

    const newFlags = `

const scriptletGlobals = {}; // eslint-disable-line

const $hasHostnames$ = true;
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

    // Rewrite pruned values into the execute-section consts (they are no longer top-level vars).
    const replacements = [
        [
            decls.$scriptletFunctions$,
            `const $scriptletFunctions$ = /* ${newScriptletFunctions.filter(Boolean).length} */\n[${newScriptletFunctions.join(',')}];`,
        ],
        [
            decls.$scriptletArgs$,
            `const $scriptletArgs$ = /* ${newScriptletArgs.filter(Boolean).length} */ ${JSON.stringify(newScriptletArgs, null, 2)};`,
        ],
        [
            decls.$scriptletArglists$,
            `const $scriptletArglists$ = /* ${newScriptletArglists.split(';').filter(Boolean).length} */ ${JSON.stringify(newScriptletArglists)};`,
        ],
        [
            decls.$scriptletArglistRefs$,
            `const $scriptletArglistRefs$ = /* ${newScriptletHostnames.length} */ ${JSON.stringify(newScriptletArglistRefs)};`,
        ],
        [
            decls.$scriptletHostnames$,
            `const $scriptletHostnames$ = /* ${newScriptletHostnames.length} */ ${JSON.stringify(newScriptletHostnames, null, 2)};`,
        ],
    ];
    if (decls.$scriptletFromRegexes$) {
        replacements.push([decls.$scriptletFromRegexes$, 'const $scriptletFromRegexes$ = /* 0 */ [];']);
    }
    let newExecute = execute;
    replacements.sort((a, b) => b[0].start - a[0].start);
    for (const [location, text] of replacements) {
        newExecute = `${newExecute.slice(0, location.start)}${text}${newExecute.slice(location.end)}`;
    }

    // Update copyright header
    const headerLines = header.split('\n');
    headerLines.splice(1, 0, [
        `    Copyright (C) 2026 Duck Duck Go, Inc.
    Modified from the original source:`,
    ]);
    return [headerLines.join('\n'), newFunctions, newFlags, newExecute, footer].join(sectionSeparator);
}
