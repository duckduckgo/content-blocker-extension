#!/usr/bin/env zx

import path from 'node:path';

const metadataPath = process.env.SCRIPTLETS_METADATA_PATH;
const privacyConfigFile = process.env.PRIVACY_CONFIG_FILE;

if (!metadataPath) {
    throw new Error('SCRIPTLETS_METADATA_PATH is required');
}

if (!privacyConfigFile) {
    throw new Error('PRIVACY_CONFIG_FILE is required');
}

const metadataAbsolutePath = path.resolve(metadataPath);
const privacyConfigAbsolutePath = path.resolve(privacyConfigFile);

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

const privacyConfig = await fs.readJson(privacyConfigAbsolutePath);
privacyConfig.settings ??= {};
privacyConfig.settings.scriptlets = {
    ...(privacyConfig.settings.scriptlets ?? {}),
    ...scriptletsMetadata,
};

await fs.writeJson(privacyConfigAbsolutePath, privacyConfig, { spaces: 1 });
echo(`Updated ${privacyConfigFile} with ${scriptletKeys.length} scriptlet entries`);
