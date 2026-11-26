// StrykerJS mutation testing of the tool manifest schema, `defineTool` and the worker pool
// (issue #162, ADR 0007 addendum). Options: ../../stryker.shared.mjs.
import { baseOptions, scope } from '../../stryker.shared.mjs';

export default {
  ...baseOptions(),
  // Every `.ts` file of the package: `manifest.ts` holds the privacy constant and `toolTextKey`, so it
  // is not "types only". Only declaration files (no runtime code) are left out.
  mutate: scope(import.meta.dirname, ['src/**/*.ts'], [/\.d\.ts$/]),
  // A test reads the sticker files of docs/design, outside this package, so the tests cannot run in a
  // sandbox copy of it: Stryker instruments the files in place and restores them at the end.
  inPlace: true,
};
