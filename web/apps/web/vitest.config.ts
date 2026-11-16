import { svelte } from '@sveltejs/vite-plugin-svelte';
import { svelteTesting } from '@testing-library/svelte/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [svelte(), svelteTesting()],
  // Resolve Svelte's client runtime (not the server one) under jsdom.
  resolve: { conditions: ['browser'] },
  test: {
    environment: 'jsdom',
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,svelte}', 'scripts/tokens.ts'],
      reporter: ['text', 'lcov'],
      // Same floor as the Rust workspace; never lower it to get green.
      thresholds: { lines: 95, functions: 95, branches: 95, statements: 95 },
    },
  },
});
