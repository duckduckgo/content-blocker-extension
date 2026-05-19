#!/usr/bin/env zx

import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { $, argv } from 'zx';

const signingKeyPath = process.env.SCRIPTLET_SIGNING_KEY_PATH;
const metadataPath = process.env.SCRIPTLETS_METADATA_PATH || 'scriptlets-metadata.json';
const s3Bucket = process.env.AWS_S3_BUCKET;
const s3Prefix = process.env.SCRIPTLETS_S3_PREFIX || 'extensions/content-blocker/scriptlets';
const cdnBaseUrl = process.env.SCRIPTLETS_CDN_BASE_URL || 'https://staticcdn.duckduckgo.com/extensions/content-blocker/scriptlets';

/** @type {Record<string, string>} */
const contentTypeByExtension = {
    '.js': 'application/javascript',
    '.json': 'application/json',
};

if (!signingKeyPath) {
    throw new Error('SCRIPTLET_SIGNING_KEY_PATH is required');
}
if (!s3Bucket) {
    throw new Error('AWS_S3_BUCKET is required');
}

const cwd = process.cwd();
const sourceDirAbsolute = path.resolve(cwd, 'src');
const sourceDirPrefix = `${sourceDirAbsolute}${path.sep}`;

/**
 * @param {string[]} paths
 * @returns {Promise<string[]>}
 */
async function resolvePublishFiles(paths) {
    if (paths.length === 0) {
        throw new Error('At least one file path is required');
    }

    const files = new Set();

    for (const filePath of paths) {
        const absolutePath = path.resolve(cwd, filePath);

        try {
            await access(absolutePath);
        } catch {
            throw new Error(`File not found: ${filePath}`);
        }

        if (!absolutePath.startsWith(sourceDirPrefix)) {
            throw new Error(`File must be under src/: ${filePath}`);
        }

        files.add(absolutePath);
    }

    return [...files].sort();
}

/**
 * @param {string} file
 * @returns {Promise<{ url: string, signature: string }>}
 */
async function publishFile(file) {
    const extension = path.extname(file);
    const contentType = contentTypeByExtension[extension];
    if (!contentType) {
        throw new Error(`Unsupported file type "${extension}" for ${file}`);
    }

    const content = await readFile(file);
    const hash = createHash('sha256').update(content).digest('hex');
    const { stdout: signatureStdout } = await $`set -o pipefail; openssl dgst -sha256 -sign ${signingKeyPath} ${file} | base64 -w0`;
    const signature = signatureStdout.trim();
    const url = `${cdnBaseUrl}/${hash}${extension}`;
    const s3Url = `s3://${s3Bucket}/${s3Prefix}/${hash}${extension}`;

    await $`aws s3 cp ${file} ${s3Url} --acl public-read --content-type ${contentType}`;

    console.log(`Uploaded ${file} -> ${s3Url}`);
    return { url, signature };
}

const publishFiles = await resolvePublishFiles(argv._);

/** @type {Record<string, { url: string, signature: string }>} */
const metadata = {};

for (const file of publishFiles) {
    const metadataKey = path.relative(sourceDirAbsolute, file).split(path.sep).join('/');
    metadata[metadataKey] = await publishFile(file);
}

await mkdir(path.dirname(metadataPath), { recursive: true });
await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
console.log(`Wrote metadata for ${publishFiles.length} files to ${metadataPath}`);
