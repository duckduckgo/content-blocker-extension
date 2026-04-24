#!/usr/bin/env zx

import path from 'node:path';

const metadataPath = process.env.SCRIPTLETS_METADATA_PATH;
const privacyConfigFile = process.env.PRIVACY_CONFIG_FILE;
const manifestFile = process.env.EXTENSION_MANIFEST_PATH ?? 'src/manifest.json';

if (!metadataPath) {
    throw new Error('SCRIPTLETS_METADATA_PATH is required');
}

if (!privacyConfigFile) {
    throw new Error('PRIVACY_CONFIG_FILE is required');
}

const metadataAbsolutePath = path.resolve(metadataPath);
const privacyConfigAbsolutePath = path.resolve(privacyConfigFile);
const manifestAbsolutePath = path.resolve(manifestFile);

if (!(await fs.pathExists(metadataAbsolutePath))) {
    throw new Error(`Scriptlet metadata file not found at ${metadataAbsolutePath}`);
}

const scriptletsMetadata = await fs.readJson(metadataAbsolutePath);
const scriptletKeys = Object.keys(scriptletsMetadata).sort();
if (scriptletKeys.length === 0) {
    throw new Error(`Scriptlet metadata file is empty: ${metadataAbsolutePath}`);
}

if (!(await fs.pathExists(privacyConfigAbsolutePath))) {
    throw new Error(`Privacy config file not found at ${privacyConfigAbsolutePath}`);
}

if (!(await fs.pathExists(manifestAbsolutePath))) {
    throw new Error(`Extension manifest not found at ${manifestAbsolutePath}`);
}

const manifest = await fs.readJson(manifestAbsolutePath);
const extensionVersion = manifest.version;
if (typeof extensionVersion !== 'string' || extensionVersion.length === 0) {
    throw new Error(`Missing or invalid version in ${manifestAbsolutePath}`);
}

const privacyConfig = await fs.readJson(privacyConfigAbsolutePath);
privacyConfig.settings ??= {};
privacyConfig.settings.version = extensionVersion;
privacyConfig.settings.scriptlets = {
    ...(privacyConfig.settings.scriptlets ?? {}),
    ...scriptletsMetadata,
};

await fs.writeJson(privacyConfigAbsolutePath, privacyConfig, { spaces: 1 });
echo(
    `Updated ${privacyConfigFile}: settings.version=${extensionVersion}, ${scriptletKeys.length} scriptlet entries`,
);
