#!/usr/bin/env zx

const { version } = await fs.readJson('./src/manifest.json');
await $`mkdir -p dist`;
cd('src');
await $`zip -r ../dist/content-blocker-extension-${version}.zip .`;
echo(`Packaged content-blocker-extension-${version}.zip`);

cd('..');
await $`rm -rf dist/apple-staging`;
await $`cp -Rp src dist/apple-staging`;
cd('dist/apple-staging');
await $`find scriptlets -type f -name '*.js' -exec sh -c ': > "$1"' _ {} \\;`;
await $`zip -r ../content-blocker-extension-apple-${version}.zip .`;
cd('..');
await $`rm -rf apple-staging`;
cd('..');
echo(`Packaged content-blocker-extension-apple-${version}.zip`);

const pathToPrivateKey = process.env.CRX_SIGNING_KEY;
if (!pathToPrivateKey) {
    console.warn('CRX_SIGNING_KEY is not set. Skipping crx3 signing.');
    process.exit(0);
}

await $`npx crx3-new ${pathToPrivateKey} < ./dist/content-blocker-extension-${version}.zip > ./dist/content-blocker-extension-${version}.crx`;
echo(`Packaged content-blocker-extension-${version}.crx`);
