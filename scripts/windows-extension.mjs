/**
 * The Windows CRX registers its content scripts from the service worker, per site group, instead of
 * injecting the manifest's static `content_scripts` on every site. Other packages keep the manifest as is.
 * @param {Record<string, any>} manifest the manifest in `src/`
 * @returns {{ manifest: Record<string, any>, contentScripts: Record<string, any>[] }}
 */
export function buildWindowsExtension(manifest) {
    const { content_scripts: contentScripts = [], ...rest } = manifest;
    const permissions = [...new Set([...(rest.permissions ?? []), 'storage'])];
    return { manifest: { ...rest, permissions }, contentScripts };
}
