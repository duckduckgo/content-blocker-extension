/**
 * `npm run update` regenerates the manifest's `content_scripts` from the
 * scriptlets fetched out of uBlock Origin Lite, which would drop any entry we
 * maintain by hand. First-party content scripts live outside `scriptlets/`, so
 * we can tell the two apart by their `js` paths and re-append ours.
 */

const generatedPathPrefix = 'scriptlets/';

/**
 * A content script is generated iff every file it injects lives under
 * `scriptlets/`. Anything else — including an entry with no `js` at all — is
 * treated as hand-maintained, so an unrecognised entry is preserved rather
 * than silently dropped.
 * @param {{ js?: string[] }} entry
 * @returns {boolean}
 */
export function isGeneratedContentScript(entry) {
    const paths = entry && entry.js;
    if (!Array.isArray(paths) || paths.length === 0) {
        return false;
    }
    return paths.every((path) => typeof path === 'string' && path.startsWith(generatedPathPrefix));
}

/**
 * Combine freshly generated scriptlet entries with the hand-maintained entries
 * already present in the manifest, preserving the relative order of each group.
 * @param {{ js?: string[] }[]} generated entries built from the uBOL scriptlets
 * @param {{ js?: string[] }[]} existing `content_scripts` from the current manifest
 * @returns {{ js?: string[] }[]}
 */
export function mergeContentScripts(generated, existing) {
    const firstParty = (existing || []).filter((entry) => !isGeneratedContentScript(entry));
    return [...generated, ...firstParty];
}
