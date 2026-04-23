#!/usr/bin/env zx

import { createHash, createPrivateKey, sign as signWithKey } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { $ } from 'zx';

const sourceScriptletsDir = process.env.SOURCE_SCRIPTLETS_DIR || 'src/scriptlets';
const signingKeyPath = process.env.SCRIPTLET_SIGNING_KEY_PATH;
const metadataPath = process.env.SCRIPTLETS_METADATA_PATH || 'scriptlets-metadata.json';
const s3Bucket = process.env.AWS_S3_BUCKET;
const s3Prefix = process.env.SCRIPTLETS_S3_PREFIX || 'extensions/content-blocker/scriptlets';
const cdnBaseUrl = process.env.SCRIPTLETS_CDN_BASE_URL || 'https://staticcdn.duckduckgo.com/extensions/content-blocker/scriptlets';

if (!signingKeyPath) {
    throw new Error('SCRIPTLET_SIGNING_KEY_PATH is required');
}
if (!s3Bucket) {
    throw new Error('AWS_S3_BUCKET is required');
}

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function listScriptletFiles(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await listScriptletFiles(fullPath)));
            continue;
        }
        if (entry.isFile() && entry.name.endsWith('.js')) {
            files.push(fullPath);
        }
    }

    return files;
}

const scriptletFiles = (await listScriptletFiles(sourceScriptletsDir)).sort();
if (scriptletFiles.length === 0) {
    throw new Error(`No .js files found under ${sourceScriptletsDir}`);
}

const privateKey = createPrivateKey(await readFile(signingKeyPath, 'utf8'));
const metadata = {};

for (const file of scriptletFiles) {
    const relativePath = path.relative(sourceScriptletsDir, file).split(path.sep).join('/');
    const scriptletKey = `scriptlets/${relativePath}`;
    const content = await readFile(file);
    const hash = createHash('sha256').update(content).digest('hex');
    const signature = signWithKey('sha256', content, privateKey).toString('base64');
    const url = `${cdnBaseUrl}/${hash}.js`;
    const s3Url = `s3://${s3Bucket}/${s3Prefix}/${hash}.js`;

    await $`aws s3 cp ${file} ${s3Url} --acl public-read --content-type application/javascript`;

    metadata[scriptletKey] = { url, signature };
    console.log(`Uploaded ${scriptletKey} -> ${s3Url}`);
}

await mkdir(path.dirname(metadataPath), { recursive: true });
await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
console.log(`Wrote metadata for ${scriptletFiles.length} scriptlets to ${metadataPath}`);
