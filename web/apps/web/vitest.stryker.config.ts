import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config.ts';

// The Vitest config StrykerJS runs (stryker.config.mjs): the same tests, with longer timeouts. The
// instrumented sources and the per-test coverage make a test several times slower, and a test that
// is fast enough in the normal run would otherwise fail the initial run of Stryker. A mutant that
// hangs still ends at Stryker's own time limit (`timeoutMS`), which counts as caught.
export default mergeConfig(
  base,
  defineConfig({
    test: {
      testTimeout: 240_000,
      hookTimeout: 240_000,
      coverage: { enabled: false },
      // The limits of the tests that guard against slow algorithms grow by this factor
      // (tests/time-budget.ts).
      env: { STRYKER_SLOWDOWN: '10' },
    },
  }),
);
