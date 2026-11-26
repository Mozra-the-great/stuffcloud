import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

// Performance budgets (T-25, #29, docs/PERFORMANCE.md). Runs in Node (type stripping): plain
// TypeScript, no Svelte runes. It reads a production build made with `vite build --manifest` and
// checks three kinds of size against the budgets, all measured as gzip (level 9) bytes, which is what
// the server sends (the Caddyfile has `encode zstd gzip`):
//
// - the shell: what the first page load needs (the JavaScript and CSS `index.html` links, plus the
//   font files that CSS names), against `perf-budgets.json`;
// - every tool's own lazy code (`scriptKb`): the chunk of its page and the chunks only tools share,
//   plus their CSS;
// - everything else a tool can download (`assetsKb`): Web Worker scripts and what they load (the pdf.js
//   engine), WASM and models. Reachability is static, so it is the upper bound of what the tool fetches.
//
// The tool budgets live in the tool manifests, the shell budgets in `perf-budgets.json`.

/** The app root: `web/apps/web`. */
export const APP_ROOT = resolve(import.meta.dirname, '..');

/** Where the budgets of the shell and the Lighthouse thresholds live. */
export const BUDGETS_FILE = 'perf-budgets.json';

const KIB = 1024;

export interface ShellBudget {
  /** JavaScript of the first page load (script and modulepreload tags of `index.html`), gzip KiB. */
  readonly scriptKb: number;
  /** CSS of the first page load, gzip KiB. */
  readonly styleKb: number;
  /** Font files the first page load's CSS names (worst case, the browser fetches only the subsets it needs), gzip KiB. */
  readonly fontsKb: number;
}

export interface LighthouseBudget {
  /** Lighthouse runs per check; the score of each category is the median of them. */
  readonly runs: number;
  /** Lowest median score of each category, 0 to 1. */
  readonly minScores: Readonly<Record<LighthouseCategory, number>>;
}

export const LIGHTHOUSE_CATEGORIES = ['performance', 'accessibility', 'best-practices'] as const;
export type LighthouseCategory = (typeof LIGHTHOUSE_CATEGORIES)[number];

export interface Budgets {
  readonly shell: ShellBudget;
  readonly lighthouse: LighthouseBudget;
}

/** A tool's budget as its manifest declares it, in gzip KiB. */
export interface ToolLimits {
  readonly scriptKb: number;
  readonly assetsKb: number;
}

/** One file of the build and its size. */
export interface Sized {
  readonly file: string;
  readonly bytes: number;
  readonly gzipBytes: number;
}

export interface Measurement {
  /** `shell` or `tool <id>`. */
  readonly scope: string;
  /** What is measured: `script`, `style`, `fonts` or `assets`. */
  readonly metric: string;
  readonly gzipBytes: number;
  readonly limitBytes: number;
  readonly files: readonly Sized[];
}

export interface Finding extends Measurement {
  readonly ok: boolean;
}

interface ManifestChunk {
  readonly file: string;
  readonly isEntry?: boolean;
  readonly imports?: readonly string[];
  readonly dynamicImports?: readonly string[];
  readonly css?: readonly string[];
  readonly assets?: readonly string[];
}

/** A production build to measure: the Vite manifest and the files of the output directory. */
export interface BuildOutput {
  readonly dist: string;
  readonly chunks: Readonly<Record<string, ManifestChunk>>;
  /** Every emitted file except source maps and the manifest, relative to `dist` with forward slashes. */
  readonly files: readonly string[];
}

function failure(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function wholeKb(value: unknown, path: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    failure(`${BUDGETS_FILE}: ${path} must be a whole number of at least ${String(minimum)}`);
  }
  return value;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      failure(`${BUDGETS_FILE}: ${path}.${key} is not a budget field (${allowed.join(', ')})`);
    }
  }
}

function section(root: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = root[name];
  if (!isRecord(value)) {
    failure(`${BUDGETS_FILE}: "${name}" must be an object`);
  }
  return value;
}

/** Reads the content of `perf-budgets.json`; throws a sentence naming the broken field. */
export function parseBudgets(input: unknown): Budgets {
  if (!isRecord(input)) {
    return failure(`${BUDGETS_FILE}: must be a JSON object`);
  }
  onlyKeys(input, ['shell', 'lighthouse'], '$');
  const shell = section(input, 'shell');
  onlyKeys(shell, ['scriptKb', 'styleKb', 'fontsKb'], 'shell');
  const lighthouse = section(input, 'lighthouse');
  onlyKeys(lighthouse, ['runs', 'minScores'], 'lighthouse');
  const runs = wholeKb(lighthouse['runs'], 'lighthouse.runs', 1);
  if (runs % 2 === 0) {
    failure(`${BUDGETS_FILE}: lighthouse.runs must be odd, so the median is one of the runs`);
  }
  const scores = section(lighthouse, 'minScores');
  onlyKeys(scores, LIGHTHOUSE_CATEGORIES, 'lighthouse.minScores');
  const minScores = {} as Record<LighthouseCategory, number>;
  for (const category of LIGHTHOUSE_CATEGORIES) {
    const score = scores[category];
    if (typeof score !== 'number' || !(score > 0 && score <= 1)) {
      failure(
        `${BUDGETS_FILE}: lighthouse.minScores.${category} must be a number above 0 and up to 1`,
      );
    }
    minScores[category] = score;
  }
  return {
    shell: {
      scriptKb: wholeKb(shell['scriptKb'], 'shell.scriptKb', 1),
      styleKb: wholeKb(shell['styleKb'], 'shell.styleKb', 1),
      fontsKb: wholeKb(shell['fontsKb'], 'shell.fontsKb', 1),
    },
    lighthouse: { runs, minScores },
  };
}

export function readBudgets(root: string = APP_ROOT): Budgets {
  const path = join(root, BUDGETS_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error: unknown) {
    return failure(`${BUDGETS_FILE}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseBudgets(parsed);
}

/** Size of `content` as the server sends it: gzip at the best level (deterministic). */
export function gzipBytes(content: Uint8Array): number {
  return gzipSync(content, { level: 9 }).length;
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

/** Reads the build in `dist`; it must have been made with `vite build --manifest`. */
export function readBuild(dist: string): BuildOutput {
  const manifestPath = join(dist, '.vite', 'manifest.json');
  if (!existsSync(manifestPath)) {
    return failure(
      `${manifestPath} is missing: build with \`vite build --manifest\` (pnpm perf:build) so the chunks can be matched to the tools`,
    );
  }
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
  if (!isRecord(parsed)) {
    return failure(`${manifestPath} is not a Vite manifest`);
  }
  const files = walk(dist)
    .map((path) => relative(dist, path).replaceAll('\\', '/'))
    .filter((name) => !name.endsWith('.map') && !name.startsWith('.vite/'))
    .toSorted();
  return { dist, chunks: parsed as Record<string, ManifestChunk>, files };
}

function sized(build: BuildOutput, file: string): Sized {
  const path = join(build.dist, file);
  if (!existsSync(path) || !statSync(path).isFile()) {
    return failure(`${file} is named by the build but does not exist in ${build.dist}`);
  }
  const content = readFileSync(path);
  return { file, bytes: content.length, gzipBytes: gzipBytes(content) };
}

function total(files: readonly Sized[]): number {
  return files.reduce((sum, item) => sum + item.gzipBytes, 0);
}

/** The files the first page load of `index.html` fetches: scripts, preloaded modules, stylesheets. */
export function shellLinks(html: string): { readonly script: string[]; readonly style: string[] } {
  const script: string[] = [];
  const style: string[] = [];
  for (const tag of html.matchAll(/<(script|link)\b([^>]*)>/g)) {
    const attributes = tag[2] ?? '';
    const target = /\b(?:src|href)="([^"]+)"/.exec(attributes)?.[1];
    if (target === undefined) {
      continue;
    }
    const rel = /\brel="([^"]+)"/.exec(attributes)?.[1];
    const isScript = tag[1] === 'script' && /\btype="module"/.test(attributes);
    if (isScript || (tag[1] === 'link' && rel === 'modulepreload')) {
      script.push(target);
    } else if (tag[1] === 'link' && rel === 'stylesheet') {
      style.push(target);
    }
  }
  return { script, style };
}

function distFile(url: string): string {
  if (!url.startsWith('/') || url.startsWith('//')) {
    return failure(`index.html links ${url}: only same-origin absolute paths are allowed`);
  }
  return url.slice(1);
}

/** Fonts (and other files) a stylesheet names with `url(...)`, as paths relative to `dist`. */
export function stylesheetFiles(css: string): string[] {
  return [...css.matchAll(/url\(\s*["']?([^)"']+)["']?\s*\)/g)]
    .map((match) => match[1] ?? '')
    .filter((url) => url.startsWith('/') && !url.startsWith('//'))
    .map((url) => url.slice(1));
}

export interface Shell {
  readonly script: readonly Sized[];
  readonly style: readonly Sized[];
  readonly fonts: readonly Sized[];
}

export function measureShell(build: BuildOutput): Shell {
  const html = readFileSync(join(build.dist, 'index.html'), 'utf8');
  const links = shellLinks(html);
  const script = [...new Set(links.script.map(distFile))].map((file) => sized(build, file));
  const style = [...new Set(links.style.map(distFile))].map((file) => sized(build, file));
  const fontFiles = new Set(
    style.flatMap(({ file }) =>
      stylesheetFiles(readFileSync(join(build.dist, file), 'utf8')).filter((name) =>
        /\.(?:woff2?|ttf|otf)$/.test(name),
      ),
    ),
  );
  return { script, style, fonts: [...fontFiles].toSorted().map((file) => sized(build, file)) };
}

export interface ToolSizes {
  readonly script: readonly Sized[];
  readonly assets: readonly Sized[];
}

/**
 * What the tool `id` brings on top of the shell. `script` is its part of the code-split graph the
 * Vite manifest records (its page chunk, the chunks it imports that the first page load did not
 * already fetch, their CSS). `assets` is everything those chunks name by file name that the manifest
 * does not list as a chunk: Web Worker scripts, what workers load in turn (the pdf.js engine), WASM.
 */
export function measureTool(build: BuildOutput, shell: Shell, id: string): ToolSizes {
  const entryKey = `src/tools/${id}/Tool.svelte`;
  const entry = build.chunks[entryKey];
  if (entry === undefined) {
    return failure(
      `tool ${id}: the build has no chunk for ${entryKey}; the manifest must load ./Tool.svelte`,
    );
  }
  const initial = new Set([...shell.script, ...shell.style].map((item) => item.file));
  const chunkFiles = new Set(Object.values(build.chunks).map((chunk) => chunk.file));
  const script = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): void => {
    const chunk = build.chunks[key];
    if (visited.has(key) || chunk === undefined || initial.has(chunk.file)) {
      return;
    }
    visited.add(key);
    script.add(chunk.file);
    for (const css of chunk.css ?? []) {
      if (!initial.has(css)) {
        script.add(css);
      }
    }
    for (const next of [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])]) {
      visit(next);
    }
  };
  visit(entryKey);

  const assets = new Set<string>();
  const known = new Set([...initial, ...script]);
  const scan = (file: string): void => {
    if (!file.endsWith('.js')) {
      return;
    }
    const source = readFileSync(join(build.dist, file), 'utf8');
    for (const candidate of build.files) {
      const name = candidate.slice(candidate.lastIndexOf('/') + 1);
      if (
        !known.has(candidate) &&
        !chunkFiles.has(candidate) &&
        !assets.has(candidate) &&
        source.includes(name)
      ) {
        assets.add(candidate);
        scan(candidate);
      }
    }
  };
  for (const file of script) {
    scan(file);
  }
  return {
    script: [...script].toSorted().map((file) => sized(build, file)),
    assets: [...assets].toSorted().map((file) => sized(build, file)),
  };
}

function limit(kb: number): number {
  return kb * KIB;
}

function measurement(
  scope: string,
  metric: string,
  files: readonly Sized[],
  limitKb: number,
): Measurement {
  return { scope, metric, gzipBytes: total(files), limitBytes: limit(limitKb), files };
}

/** One finding per limit; a size exactly at the limit passes, one byte over fails. */
export function evaluate(measurements: readonly Measurement[]): Finding[] {
  return measurements.map((item) => ({ ...item, ok: item.gzipBytes <= item.limitBytes }));
}

/** Measures the shell and every tool of `limits` (tool id to its manifest budget) against the budgets. */
export function check(
  build: BuildOutput,
  budgets: Budgets,
  limits: ReadonlyMap<string, ToolLimits>,
): Finding[] {
  const shell = measureShell(build);
  const measurements: Measurement[] = [
    measurement('shell', 'script', shell.script, budgets.shell.scriptKb),
    measurement('shell', 'style', shell.style, budgets.shell.styleKb),
    measurement('shell', 'fonts', shell.fonts, budgets.shell.fontsKb),
  ];
  for (const [id, toolLimits] of [...limits].toSorted(([a], [b]) => a.localeCompare(b))) {
    const sizes = measureTool(build, shell, id);
    measurements.push(
      measurement(`tool ${id}`, 'script', sizes.script, toolLimits.scriptKb),
      measurement(`tool ${id}`, 'assets', sizes.assets, toolLimits.assetsKb),
    );
  }
  return evaluate(measurements);
}

function kib(bytes: number): string {
  return (bytes / KIB).toFixed(2);
}

/** The table printed for a run and written to the job summary. */
export function formatTable(findings: readonly Finding[]): string {
  const rows = findings.map(
    (finding) =>
      `| ${finding.ok ? 'ok' : 'OVER'} | ${finding.scope} | ${finding.metric} | ${String(finding.gzipBytes)} B (${kib(finding.gzipBytes)} KiB) | ${String(finding.limitBytes)} B (${kib(finding.limitBytes)} KiB) |`,
  );
  return ['| | Scope | Metric | gzip size | Budget |', '|---|---|---|---|---|', ...rows].join('\n');
}

/** The message of a failed run: each exceeded budget with its exact numbers, the files, and the way out. */
export function formatFailures(findings: readonly Finding[]): string {
  const over = findings.filter((finding) => !finding.ok);
  const lines = over.flatMap((finding) => [
    `- ${finding.scope}, ${finding.metric}: ${String(finding.gzipBytes)} B gzip (${kib(finding.gzipBytes)} KiB) is ${String(finding.gzipBytes - finding.limitBytes)} B over the budget of ${String(finding.limitBytes)} B (${kib(finding.limitBytes)} KiB)`,
    ...finding.files.map(
      (item) => `    ${item.file}: ${String(item.gzipBytes)} B gzip, ${String(item.bytes)} B raw`,
    ),
  ]);
  return [
    `${String(over.length)} performance budget${over.length === 1 ? '' : 's'} exceeded:`,
    ...lines,
    'Make the code smaller or load it later. A bigger budget is a reviewed change: the `budget` of the tool manifest (tools) or perf-budgets.json (shell), with the reason in the PR (docs/PERFORMANCE.md).',
  ].join('\n');
}

/** The tool budgets of `src/tools/*\/manifest.ts` under `root`, by tool id. */
export async function readToolLimits(root: string = APP_ROOT): Promise<Map<string, ToolLimits>> {
  const toolsDir = join(root, 'src', 'tools');
  const limits = new Map<string, ToolLimits>();
  const directories = readdirSync(toolsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();
  for (const directory of directories) {
    const module = (await import(
      /* @vite-ignore */ pathToFileURL(join(toolsDir, directory, 'manifest.ts')).href
    )) as { default?: { id?: string; budget?: ToolLimits } };
    const manifest = module.default;
    if (manifest?.id === undefined || manifest.budget === undefined) {
      return failure(
        `src/tools/${directory}/manifest.ts has no default export with an id and a budget`,
      );
    }
    limits.set(manifest.id, {
      scriptKb: manifest.budget.scriptKb,
      assetsKb: manifest.budget.assetsKb,
    });
  }
  return limits;
}

export interface CliIo {
  readonly out: (message: string) => void;
  readonly err: (message: string) => void;
}

const USAGE = 'usage: check-budgets [--dist <build directory>] [--summary <markdown file>]';

/**
 * CLI logic of `pnpm check-budgets`: returns the exit code (0 within every budget, 1 a budget exceeded
 * or the build unreadable, 2 usage).
 */
export async function runBudgetCli(
  args: readonly string[],
  io: CliIo,
  root: string = APP_ROOT,
): Promise<number> {
  let dist = join(root, 'dist-perf');
  let summary: string | undefined;
  for (let at = 0; at < args.length; at += 2) {
    const value = args[at + 1];
    if (
      (args[at] !== '--dist' && args[at] !== '--summary') ||
      value === undefined ||
      value === ''
    ) {
      io.err(USAGE);
      return 2;
    }
    if (args[at] === '--dist') {
      dist = resolve(value);
    } else {
      summary = resolve(value);
    }
  }
  let findings: Finding[];
  try {
    findings = check(readBuild(dist), readBudgets(root), await readToolLimits(root));
  } catch (error: unknown) {
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const table = formatTable(findings);
  io.out(table);
  if (summary !== undefined) {
    writeFileSync(summary, `## Performance budgets\n\n${table}\n`, { flag: 'a' });
  }
  if (findings.some((finding) => !finding.ok)) {
    io.err(formatFailures(findings));
    return 1;
  }
  io.out(`all ${String(findings.length)} budgets are met`);
  return 0;
}
