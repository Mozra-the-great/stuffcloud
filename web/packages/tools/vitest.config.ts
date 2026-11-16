import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'lcov'],
      // Same floor as the Rust workspace; never lower it to get green.
      thresholds: { lines: 95, functions: 95, branches: 95, statements: 95 },
    },
  },
});
