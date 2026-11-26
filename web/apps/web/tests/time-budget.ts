/**
 * The time limit of a test that guards against a slow algorithm (a hostile document, a large
 * diff), as it is written in the test. StrykerJS (`pnpm test:mutation`, issue #162) runs the
 * same tests against instrumented sources, which are several times slower; its Vitest config
 * (`vitest.stryker.config.ts`) sets `STRYKER_SLOWDOWN` and the limit grows by that factor, so
 * the test still tells a linear run from a quadratic one without failing the initial run. In
 * every other run the limit is the number in the test.
 */
export function timeBudget(milliseconds: number): number {
  const factor = Number(process.env['STRYKER_SLOWDOWN'] ?? '1');
  return milliseconds * (Number.isFinite(factor) && factor >= 1 ? factor : 1);
}
