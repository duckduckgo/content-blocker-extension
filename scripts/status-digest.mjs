#!/usr/bin/env zx

/**
 * Build a Content Blocker status digest from recent GitHub Actions runs and PRs.
 *
 * Usage:
 *   npx zx ./scripts/status-digest.mjs
 *   LOOKBACK_HOURS=24 npx zx ./scripts/status-digest.mjs
 *
 * Env:
 *   LOOKBACK_HOURS       Lookback window in hours (default: 24)
 *   GH_TOKEN             Token for this-repo runs/PRs (gh auth login also works)
 *   PRIVACY_CONFIG_PAT   Optional PAT to list PRs in duckduckgo/privacy-configuration
 *   GITHUB_OUTPUT        If set (Actions), writes `comment` multiline output
 */

import { appendFile } from 'node:fs/promises';

const LOOKBACK_HOURS = Number(process.env.LOOKBACK_HOURS ?? 24);
const PRIVACY_CONFIG_PAT = process.env.PRIVACY_CONFIG_PAT ?? '';
const PRIVACY_CONFIG_REPO = 'duckduckgo/privacy-configuration';
const RUN_JSON_FIELDS = 'databaseId,conclusion,status,createdAt,updatedAt,url,event,displayTitle';
const PR_JSON_FIELDS = 'number,url,title,state,createdAt,closedAt,mergedAt';
const REMOTE_PR_JSON_FIELDS = `${PR_JSON_FIELDS},headRefName`;

const FAILURE_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'startup_failure', 'action_required']);
const IN_PROGRESS_STATUSES = new Set(['queued', 'in_progress', 'pending', 'requested', 'waiting']);

$.verbose = false;

const nowMs = Date.now();
const cutoffMs = nowMs - LOOKBACK_HOURS * 60 * 60 * 1000;

/**
 * @param {string | null | undefined} iso
 * @returns {number}
 */
function toMs(iso) {
    if (!iso) {
        return 0;
    }
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? 0 : ms;
}

/**
 * @param {string} iso
 * @returns {string}
 */
function formatUtc(iso) {
    const date = new Date(iso);
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(date.getUTCDate()).padStart(2, '0');
    const hh = String(date.getUTCHours()).padStart(2, '0');
    const mi = String(date.getUTCMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${mi} UTC`;
}

/**
 * @param {string} workflow
 * @returns {Promise<object[]>}
 */
async function listRunsInWindow(workflow) {
    const raw = await $`gh run list --workflow ${workflow} --limit 5 --json ${RUN_JSON_FIELDS}`;
    const runs = JSON.parse(raw.stdout);
    return runs.filter((run) => toMs(run.createdAt) >= cutoffMs);
}

/**
 * @param {object[]} runs
 * @returns {string[]}
 */
function formatRunLines(runs) {
    if (runs.length === 0) {
        return ['- did not run'];
    }
    return runs.map((run) => {
        const outcome = run.status !== 'completed' ? run.status : (run.conclusion ?? 'unknown');
        return `- ${formatUtc(run.createdAt)} — ${outcome} — ${run.url}`;
    });
}

/**
 * @param {object[]} runs
 * @returns {string[]}
 */
function collectSignals(runs) {
    return runs.map((run) => (run.status !== 'completed' ? run.status : (run.conclusion ?? 'unknown')));
}

/**
 * @param {object[]} prs
 * @returns {object | null}
 */
function pickRelevantPr(prs) {
    const relevant = prs.filter((pr) => {
        if (pr.state === 'OPEN') {
            return true;
        }
        return toMs(pr.createdAt) >= cutoffMs || toMs(pr.mergedAt) >= cutoffMs || toMs(pr.closedAt) >= cutoffMs;
    });

    relevant.sort((a, b) => {
        const openRank = (pr) => (pr.state === 'OPEN' ? 0 : 1);
        const byOpen = openRank(a) - openRank(b);
        if (byOpen !== 0) {
            return byOpen;
        }
        return toMs(b.createdAt) - toMs(a.createdAt);
    });

    return relevant[0] ?? null;
}

/**
 * @param {string} label
 * @param {object[]} prs
 * @returns {string}
 */
function formatPrLine(label, prs) {
    const chosen = pickRelevantPr(prs);
    if (!chosen) {
        return `${label}: none`;
    }

    const state = String(chosen.state).toLowerCase();
    if (state === 'open') {
        return `${label}: opened #${chosen.number} — ${chosen.title} — ${chosen.url}`;
    }
    return `${label}: #${chosen.number} ${state} — ${chosen.title} — ${chosen.url}`;
}

/**
 * @param {string[]} signals
 * @param {boolean} dailyMissing
 * @returns {string}
 */
function overallStatus(signals, dailyMissing) {
    if (signals.some((signal) => FAILURE_CONCLUSIONS.has(signal))) {
        return 'FAILED';
    }
    if (signals.some((signal) => IN_PROGRESS_STATUSES.has(signal))) {
        return 'IN PROGRESS';
    }
    if (dailyMissing) {
        return 'MISSING';
    }
    return 'OK';
}

/**
 * @param {string} comment
 * @returns {Promise<void>}
 */
async function writeGithubOutput(comment) {
    const outputPath = process.env.GITHUB_OUTPUT;
    if (!outputPath) {
        return;
    }
    const delimiter = `EOF_${Date.now()}`;
    await appendFile(outputPath, `comment<<${delimiter}\n${comment}\n${delimiter}\n`);
}

const dailyRuns = await listRunsInWindow('daily-update.yml');
const publishRuns = await listRunsInWindow('publish-scriptlets.yml');
const privacyRuns = await listRunsInWindow('privacy-config-pr.yml');

const localPrsRaw = await $`gh pr list --head update/scriptlets-auto --state all --limit 5 --json ${PR_JSON_FIELDS}`;
const localPrs = JSON.parse(localPrsRaw.stdout);

/** @type {object[]} */
let remotePrs = [];
if (PRIVACY_CONFIG_PAT) {
    const remoteRaw = await $({
        env: { ...process.env, GH_TOKEN: PRIVACY_CONFIG_PAT },
    })`gh pr list -R ${PRIVACY_CONFIG_REPO} --state all --limit 30 --json ${REMOTE_PR_JSON_FIELDS}`;
    remotePrs = JSON.parse(remoteRaw.stdout);
} else {
    echo('Warning: PRIVACY_CONFIG_PAT is not set; skipping privacy-configuration PR lookup');
}

const scriptletsConfigPrs = remotePrs.filter((pr) => String(pr.headRefName ?? '').startsWith('update-ad-blocking-extension-scriptlets-'));
const extensionUrlPrs = remotePrs.filter((pr) => String(pr.headRefName ?? '').startsWith('update-content-blocker-extension-'));

const signals = [...collectSignals(dailyRuns), ...collectSignals(publishRuns), ...collectSignals(privacyRuns)];
const overall = overallStatus(signals, dailyRuns.length === 0);

const comment = [
    `Content Blocker status (last ${LOOKBACK_HOURS}h)`,
    '',
    `Overall: ${overall}`,
    '',
    'Daily Update:',
    ...formatRunLines(dailyRuns),
    formatPrLine('Scriptlets PR', localPrs),
    '',
    'Publish scriptlets:',
    ...formatRunLines(publishRuns),
    formatPrLine('privacy-configuration PR', scriptletsConfigPrs),
    '',
    'Privacy-config PR:',
    ...formatRunLines(privacyRuns),
    formatPrLine('privacy-configuration PR', extensionUrlPrs),
].join('\n');

echo(comment);
await writeGithubOutput(comment);
