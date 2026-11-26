// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import svelte from 'eslint-plugin-svelte';
import tseslint from 'typescript-eslint';

const typeScriptFiles = ['**/*.ts', '**/*.svelte'];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-e2e/**',
      '**/test-results/**',
      '**/playwright-report/**',
      '**/coverage/**',
      '**/.stryker-tmp/**',
      '**/stryker-setup-*.js',
      '**/reports/**',
      'packages/api-client/src/generated/**',
      // Deliberately bad code; only the lint-config test lints it (with `ignore: false`).
      'tests/fixtures/**',
      // Throw-away app trees the web tests create and remove.
      '**/.tmp-*/**',
    ],
  },
  js.configs.recommended,
  {
    files: typeScriptFiles,
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: ['.svelte'],
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        { allowExpressions: true, allowTypedFunctionExpressions: true },
      ],
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/strict-boolean-expressions': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
  ...svelte.configs['flat/recommended'].map((config) => ({
    ...config,
    files: config.files ?? ['**/*.svelte'],
  })),
  {
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { parser: tseslint.parser },
    },
  },
  {
    // Rune-aware: `let { a, b = $bindable() } = $props()` is not a reassignable `let`.
    files: ['**/*.svelte', '**/*.svelte.ts'],
    plugins: { svelte },
    rules: { 'prefer-const': 'off', 'svelte/prefer-const': 'error' },
  },
  {
    files: ['apps/web/**/*.ts'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
);
