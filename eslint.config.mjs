import ddgConfig from '@duckduckgo/eslint-config';
import globals from 'globals';

export default [
    ...ddgConfig,
    {
        ignores: ['src/scriptlets/**'],
    },
    {
        files: ['scripts/*.mjs'],
        languageOptions: {
            globals: {
                ...globals.node,
                $: 'readonly',
                cd: 'readonly',
                echo: 'readonly',
                fs: 'readonly',
            },
        },
    },
];
