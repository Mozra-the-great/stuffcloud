// Shared by the Stryker configs of the packages (issue #162, ADR 0007 addendum). Run Stryker through
// `pnpm test:mutation`, in a package or at the workspace root.
import { globSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

const workspaceRoot = import.meta.dirname;

/**
 * Options every package shares. `thresholds.break: 100` makes any survivor, any mutant that no test
 * covers and any run that mutated nothing fail the run; never lower it and never exclude a file to
 * get green. An equivalent mutant gets `// Stryker disable next-line <mutator>: <reason>` next to
 * the code, with the proof as the reason.
 *
 * @returns {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export function baseOptions() {
  return {
    // pnpm does not hoist the plugin next to `@stryker-mutator/core`, so it is named here.
    plugins: ['@stryker-mutator/vitest-runner'],
    testRunner: 'vitest',
    vitest: { configFile: 'vitest.stryker.config.ts' },
    // Only the tests that cover the mutated line run for a mutant.
    coverageAnalysis: 'perTest',
    thresholds: { high: 100, low: 100, break: 100 },
    // A mutant that sends a loop into an endless run ends as a timeout, which counts as caught (as
    // with the time limit of `cargo mutants`); the tests of the worker time limits wait for real.
    timeoutMS: 5_000,
    timeoutFactor: 2,
    // The initial run executes every test once with the coverage of each mutant recorded: minutes, not seconds.
    dryRunTimeoutMinutes: 30,
    reporters: ['clear-text', 'progress', 'html', 'json'],
    htmlReporter: { fileName: 'reports/mutation/mutation.html' },
    jsonReporter: { fileName: 'reports/mutation/mutation.json' },
    incrementalFile: 'reports/mutation/stryker-incremental.json',
  };
}

/**
 * The files to mutate: everything `include` matches in the package directory, minus the `exclude`
 * patterns (regular expressions on the path relative to the package, forward slashes).
 *
 * - `STRYKER_CHANGED_FILES_FILE` (a text file, paths relative to `web/`, one per line; the PR job): only the files of
 *   that list. An empty result is fine there, and the CI job does not start Stryker for it.
 * - `STRYKER_SHARD` (`<index>/<count>`; the nightly run): one share of the files, split by size so
 *   the shares take about as long as each other.
 *
 * A full run that finds no file at all is a broken glob and throws: it must never pass as "nothing
 * to mutate".
 *
 * @param {string} packageDir absolute path of the package
 * @param {readonly string[]} include glob patterns relative to the package
 * @param {readonly RegExp[]} exclude
 * @returns {string[]} paths relative to the package, forward slashes
 */
export function scope(packageDir, include, exclude) {
  const all = include
    .flatMap((pattern) => globSync(pattern, { cwd: packageDir }))
    .map((path) => path.replaceAll(sep, '/'))
    .filter((path) => !exclude.some((pattern) => pattern.test(path)))
    .sort();
  if (all.length === 0) {
    throw new Error(`The Stryker scope of ${packageDir} matches no file`);
  }
  const changedFile = process.env.STRYKER_CHANGED_FILES_FILE;
  if (changedFile !== undefined) {
    const changedSet = new Set(
      readFileSync(changedFile, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .map((line) => relative(packageDir, resolve(workspaceRoot, line)).replaceAll(sep, '/')),
    );
    return all.filter((path) => changedSet.has(path));
  }
  const shard = process.env.STRYKER_SHARD;
  if (shard !== undefined) {
    return shardOf(packageDir, all, shard);
  }
  return all;
}

/**
 * Greedy split by file size: the biggest file goes to the lightest share, so the result does not
 * depend on the order of the directory listing and every share gets a similar number of mutants.
 *
 * @param {string} packageDir
 * @param {readonly string[]} files
 * @param {string} shard `<index>/<count>`
 * @returns {string[]}
 */
function shardOf(packageDir, files, shard) {
  const match = /^(\d+)\/(\d+)$/.exec(shard);
  if (match === null) {
    throw new Error(`STRYKER_SHARD must look like 0/4, got "${shard}"`);
  }
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (count < 1 || index >= count) {
    throw new Error(`STRYKER_SHARD "${shard}" is out of range`);
  }
  const sized = files
    .map((path) => ({ path, size: statSync(resolve(packageDir, path)).size }))
    .sort((a, b) => b.size - a.size || a.path.localeCompare(b.path));
  const load = new Array(count).fill(0);
  const shares = Array.from({ length: count }, () => /** @type {string[]} */ ([]));
  for (const { path, size } of sized) {
    const lightest = load.indexOf(Math.min(...load));
    load[lightest] += size;
    shares[lightest].push(path);
  }
  return shares[index].sort();
}
