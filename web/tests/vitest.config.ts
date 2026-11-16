import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: import.meta.dirname,
    environment: 'node',
    include: ['*.test.ts'],
    // Linting with type information loads the whole program; give it room.
    testTimeout: 60_000,
  },
});
