import { resolve } from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { svelteTesting } from '@testing-library/svelte/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [svelte(), svelteTesting()],
  // The mascot art is imported from `docs/design`, outside the pnpm workspace root.
  server: { fs: { allow: [resolve(import.meta.dirname, '../../..')] } },
  // Resolve Svelte's client runtime (not the server one) under jsdom.
  // As in the production build: assets are files, never data: URIs.
  build: { assetsInlineLimit: 0 },
  resolve: { conditions: ['browser'] },
  test: {
    environment: 'jsdom',
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: [
        'src/**/*.{ts,svelte}',
        'scripts/tokens.ts',
        'scripts/tool-check.ts',
        'scripts/scaffold.ts',
        'scripts/perf-budget.ts',
        'scripts/lighthouse-scores.ts',
        'scripts/static-server.ts',
        'bench/**/*.ts',
      ],
      // Process wiring that only runs against a real Chrome (the page adapters and the driver);
      // everything with logic in `bench/` is counted. The browser run is recorded in ADR 0008.
      exclude: ['bench/page.ts', 'bench/run.ts'],
      reporter: ['text', 'lcov'],
      // Same floor as the Rust workspace; never lower it to get green.
      thresholds: { lines: 95, functions: 95, branches: 95, statements: 95 },
    },
  },
});
