import { DEFAULT_GROUPS, contentScriptsFor, rulesetsFor } from './site-groups.js';

async function manifestContentScripts() {
    const response = await fetch(chrome.runtime.getURL('content-scripts.json'));
    return response.json();
}

// onInstalled and calls from the app can overlap on a fresh install; run them one at a time so the last call wins.
let queue = Promise.resolve();
function enqueue(task) {
    const run = queue.then(task);
    queue = run.catch(() => {});
    return run;
}

async function getState() {
    const registered = await chrome.scripting.getRegisteredContentScripts();
    const rulesets = await chrome.declarativeNetRequest.getEnabledRulesets();
    const { siteGroups } = await chrome.storage.local.get('siteGroups');
    return { siteGroups, registered: registered.map((s) => s.id), rulesets };
}

async function applySiteGroups(groups) {
    const merged = { ...DEFAULT_GROUPS, ...groups };
    await chrome.scripting.unregisterContentScripts();
    const scripts = contentScriptsFor(merged, await manifestContentScripts());
    if (scripts.length) {
        await chrome.scripting.registerContentScripts(scripts);
    }
    await chrome.declarativeNetRequest.updateEnabledRulesets(rulesetsFor(merged));
    await chrome.storage.local.set({ siteGroups: merged });
    return getState();
}

function setSiteGroups(groups) {
    return enqueue(() => applySiteGroups(groups));
}

// Updates clear dynamically registered scripts; restore the last groups the app set.
chrome.runtime.onInstalled.addListener(() =>
    enqueue(async () => {
        const { siteGroups } = await chrome.storage.local.get('siteGroups');
        await applySiteGroups(siteGroups ?? DEFAULT_GROUPS);
    }),
);

globalThis.setSiteGroups = setSiteGroups;
globalThis.getState = getState;
