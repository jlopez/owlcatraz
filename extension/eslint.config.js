import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default [
  {
    ignores: ['dist/', 'node_modules/'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['*.config.{js,ts}', 'eslint.config.js', 'manifest.config.ts', 'tests/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    files: ['src/popup/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.browser,
        chrome: 'readonly',
      },
    },
  },
  {
    // MV3 service workers run in a ServiceWorkerGlobalScope — no DOM globals.
    // `globals.serviceworker` covers most of the surface; the listed extras are
    // present at runtime in Chrome MV3 but missing from that preset.
    files: ['src/background/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.serviceworker,
        chrome: 'readonly',
        AbortController: 'readonly',
        structuredClone: 'readonly',
        EventTarget: 'readonly',
        DOMException: 'readonly',
      },
    },
  },
];
