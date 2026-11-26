// StrykerJS mutation testing of the TypeScript logic of the app (issue #162, ADR 0007 addendum).
// `pnpm test:mutation` mutates every file `scope` returns and reruns only the Vitest tests that
// cover the mutated line; a mutant no test notices is a missing test (options: ../../stryker.shared.mjs).
import { baseOptions, scope } from '../../stryker.shared.mjs';

export default {
  ...baseOptions(),
  mutate: scope(
    import.meta.dirname,
    // The TypeScript logic of the tools and of what the PDF tools share (ADR 0004, 0012, 0013).
    ['src/tools/*/**/*.ts', 'src/pdf/**/*.ts'],
    [
      // A test is the check, not the subject.
      /\.test\.ts$/,
      // Manifests are static data (message keys, lazy imports) validated by the manifest schema,
      // which packages/tools mutates, and by `pnpm check-tools`.
      /^src\/tools\/[^/]+\/manifest\.ts$/,
      // Declaration files have no runtime code.
      /\.d\.ts$/,
    ],
  ),
  // The tests read files outside this package (docs/design, packages/tools/src), so they cannot run in
  // a sandbox copy of it: Stryker instruments the files in place and restores them at the end.
  inPlace: true,
};
