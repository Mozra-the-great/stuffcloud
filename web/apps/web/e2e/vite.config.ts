import { resolve } from 'node:path';
import { defineConfig, mergeConfig } from 'vite';
import base from '../vite.config.ts';
import { E2E_DIST } from './paths.ts';

/** The end-to-end build: the production app, plus the test-only tools of `e2e/app/tools`. */
export default mergeConfig(
  base,
  defineConfig({
    // The one difference to the production build: the app reads its tool list from
    // `e2e/app/tool-entries.ts`, which adds the test-only tools and their texts. Everything else
    // (shell, router, base components, minified output, CSP-friendly assets) is the real app.
    resolve: {
      alias: [
        {
          find: /^\.\/app\/tool-entries\.ts$/,
          replacement: resolve(import.meta.dirname, 'app/tool-entries.ts'),
        },
      ],
    },
    build: { outDir: E2E_DIST, emptyOutDir: true },
  }),
);
