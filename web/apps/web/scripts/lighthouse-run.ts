import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launch } from 'chrome-launcher';
import lighthouse, { generateReport } from 'lighthouse';
import {
  APP_ROOT,
  LIGHTHOUSE_CATEGORIES,
  readBudgets,
  type LighthouseCategory,
} from './perf-budget.ts';
import {
  evaluateScores,
  formatScoreFailures,
  formatScores,
  type RunScores,
} from './lighthouse-scores.ts';
import { serveBuild } from './static-server.ts';

// The Lighthouse gate (T-25, #29): the production build of `pnpm perf:build`, served as Caddy serves
// it (static-server.ts, never the dev server), audited in headless Chrome `runs` times; the median of each
// category must reach its minimum in perf-budgets.json. This file is the wiring around Chrome and
// Lighthouse and has no logic worth a unit test of its own: the scores arithmetic is in
// lighthouse-scores.ts, the server in static-server.ts, and the CI job `lighthouse` is the test of the
// whole.
//
// Deterministic settings: Lighthouse's own mobile profile (Moto G Power emulation, slow 4G, 4x CPU
// slowdown), `simulate` throttling (computed from the trace, not slept through, so the load of the
// machine moves the result less than real throttling would), a fresh Chrome profile per run, no
// extensions, one page, the three categories of the issue only.

const REPORT_DIR = '.lighthouse';

// `--no-sandbox`: the runner's Chrome only ever opens the loopback server of this script; the
// user-namespace sandbox is not available in every container.
const CHROME_FLAGS = [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--disable-extensions',
  '--no-first-run',
  '--password-store=basic',
  // Nothing but the loopback server may be reached: a run never depends on the network or on a third
  // party (an antivirus or proxy that injects a script into pages cannot skew the numbers either).
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost',
] as const;

function categoryScore(
  categories: Readonly<Record<string, { readonly score: number | null } | undefined>>,
  category: LighthouseCategory,
): number {
  const score = categories[category]?.score;
  if (score === null || score === undefined) {
    throw new Error(`Lighthouse returned no score for ${category}`);
  }
  return score;
}

async function runOnce(url: string, index: number, reports: string): Promise<RunScores> {
  const chrome = await launch({ chromeFlags: [...CHROME_FLAGS], logLevel: 'silent' });
  try {
    const result = await lighthouse(url, {
      port: chrome.port,
      logLevel: 'error',
      output: 'html',
      onlyCategories: [...LIGHTHOUSE_CATEGORIES],
      formFactor: 'mobile',
      throttlingMethod: 'simulate',
    });
    if (result === undefined) {
      throw new Error('Lighthouse returned no result');
    }
    writeFileSync(
      join(reports, `run-${String(index + 1)}.html`),
      generateReport(result.lhr, 'html'),
    );
    const scores = {} as Record<LighthouseCategory, number>;
    for (const category of LIGHTHOUSE_CATEGORIES) {
      scores[category] = categoryScore(result.lhr.categories, category);
    }
    return scores;
  } finally {
    chrome.kill();
  }
}

/** `pnpm lighthouse [--dist <dir>] [--summary <markdown file>]`: returns the exit code. */
export async function runLighthouseGate(args: readonly string[]): Promise<number> {
  let dist = join(APP_ROOT, 'dist-perf');
  let summary: string | undefined;
  for (let at = 0; at < args.length; at += 2) {
    const value = args[at + 1];
    if (
      (args[at] !== '--dist' && args[at] !== '--summary') ||
      value === undefined ||
      value === ''
    ) {
      process.stderr.write(
        'usage: lighthouse [--dist <build directory>] [--summary <markdown file>]\n',
      );
      return 2;
    }
    if (args[at] === '--dist') {
      dist = resolve(value);
    } else {
      summary = resolve(value);
    }
  }
  const budget = readBudgets().lighthouse;
  const reports = join(APP_ROOT, REPORT_DIR);
  rmSync(reports, { recursive: true, force: true });
  mkdirSync(reports, { recursive: true });
  const server = await serveBuild(dist);
  const runs: RunScores[] = [];
  try {
    for (let index = 0; index < budget.runs; index += 1) {
      runs.push(await runOnce(server.url, index, reports));
    }
  } finally {
    await server.close();
  }
  const findings = evaluateScores(runs, budget);
  const table = formatScores(findings);
  process.stdout.write(`${table}\n`);
  if (summary !== undefined) {
    writeFileSync(summary, `## Lighthouse (${String(budget.runs)} runs, median)\n\n${table}\n`, {
      flag: 'a',
    });
  }
  if (findings.some((finding) => !finding.ok)) {
    process.stderr.write(`${formatScoreFailures(findings)}\n`);
    return 1;
  }
  return 0;
}
