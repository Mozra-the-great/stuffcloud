import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  APP_ROOT,
  BUDGETS_FILE,
  check,
  evaluate,
  formatFailures,
  formatTable,
  gzipBytes,
  measureShell,
  measureTool,
  parseBudgets,
  readBudgets,
  readBuild,
  readToolLimits,
  runBudgetCli,
  shellLinks,
  stylesheetFiles,
  type Budgets,
  type BuildOutput,
  type Finding,
  type Measurement,
  type Sized,
  type ToolLimits,
} from '../scripts/perf-budget.ts';
import { appRoot } from './helpers.ts';
import { addTexts, createTempRoot, manifestSource, type TempRoot } from './tmp-root.ts';

const KIB = 1024;
const created: string[] = [];
const roots: TempRoot[] = [];

afterEach(() => {
  for (const path of created.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
  for (const root of roots.splice(0)) {
    root.remove();
  }
});

/** Pseudo-random bytes (a fixed sequence: the gzip size of a test file never changes). */
function noise(length: number, seed = 1): Buffer {
  const bytes = Buffer.alloc(length);
  let state = seed;
  for (let at = 0; at < length; at += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    bytes[at] = state >>> 24;
  }
  return bytes;
}

/** Noise whose gzip size is exactly `target` bytes. */
function gzipping(target: number, seed = 1): Buffer {
  for (let length = Math.max(1, target - 40); length <= target; length += 1) {
    const bytes = noise(length, seed);
    if (gzipSync(bytes, { level: 9 }).length === target) {
      return bytes;
    }
  }
  throw new Error(`no noise gzips to ${String(target)} bytes`);
}

interface ChunkSpec {
  readonly file: string;
  readonly imports?: readonly string[];
  readonly dynamicImports?: readonly string[];
  readonly css?: readonly string[];
}

interface DistSpec {
  readonly html: string;
  readonly chunks: Readonly<Record<string, ChunkSpec>>;
  readonly files: Readonly<Record<string, string | Buffer>>;
}

function makeDist(spec: DistSpec): string {
  const dist = mkdtempSync(join(tmpdir(), 'stuffcloud-perf-'));
  created.push(dist);
  const put = (name: string, content: string | Buffer): void => {
    mkdirSync(dirname(join(dist, name)), { recursive: true });
    writeFileSync(join(dist, name), content);
  };
  put('index.html', spec.html);
  put('.vite/manifest.json', JSON.stringify(spec.chunks));
  put('assets/ignored.js.map', 'not counted');
  for (const [name, content] of Object.entries(spec.files)) {
    put(name, content);
  }
  return dist;
}

const HTML = `<!doctype html><html><head>
<script type="module" crossorigin src="/assets/index-a.js"></script>
<link rel="modulepreload" crossorigin href="/assets/core-a.js">
<link rel="stylesheet" crossorigin href="/assets/app-a.css">
<link rel="icon" href="data:,">
</head><body><div id="app"></div></body></html>`;

/** A small app: the shell (index, core, one stylesheet, one font) and tools built on it. */
function app(extra: Partial<DistSpec> = {}): DistSpec {
  return {
    html: HTML,
    chunks: {
      'index.html': { file: 'assets/index-a.js', imports: ['_core-a.js'] },
      '_core-a.js': { file: 'assets/core-a.js' },
      'src/tools/alpha/Tool.svelte': {
        file: 'assets/alpha-a.js',
        imports: ['_core-a.js', '_shared-a.js'],
        css: ['assets/alpha-a.css', 'assets/app-a.css'],
      },
      'src/tools/beta/Tool.svelte': {
        file: 'assets/beta-a.js',
        imports: ['_shared-a.js'],
        dynamicImports: ['src/lazy.ts'],
      },
      '_shared-a.js': { file: 'assets/shared-a.js' },
      'src/lazy.ts': { file: 'assets/lazy-a.js' },
    },
    files: {
      'assets/index-a.js': 'index'.repeat(50),
      'assets/core-a.js': 'core'.repeat(80),
      'assets/app-a.css': '@font-face{src:url(/assets/font-a.woff2)}body{color:red}',
      'assets/font-a.woff2': noise(300),
      'assets/alpha-a.js': 'alpha'.repeat(40),
      'assets/alpha-a.css': '.alpha{color:blue}',
      'assets/beta-a.js': 'new Worker(new URL("worker-a.js", import.meta.url))',
      'assets/shared-a.js': 'shared'.repeat(40),
      'assets/lazy-a.js': 'lazy'.repeat(30),
      'assets/worker-a.js': 'worker uses engine-a.js'.repeat(20),
      'assets/engine-a.js': noise(500, 7),
      ...extra.files,
    },
    ...(extra.html === undefined ? {} : { html: extra.html }),
  };
}

const BUDGETS: Budgets = {
  shell: { scriptKb: 100, styleKb: 100, fontsKb: 100 },
  lighthouse: {
    runs: 5,
    minScores: { performance: 0.95, accessibility: 0.95, 'best-practices': 0.95 },
  },
};

function names(items: readonly Sized[]): string[] {
  return items.map((item) => item.file);
}

describe('parseBudgets', () => {
  const valid = {
    shell: { scriptKb: 100, styleKb: 10, fontsKb: 200 },
    lighthouse: {
      runs: 5,
      minScores: { performance: 0.95, accessibility: 1, 'best-practices': 0.9 },
    },
  };

  it('reads a valid file, and the real one', () => {
    expect(parseBudgets(valid)).toEqual(valid);
    const real = readBudgets();
    expect(real.lighthouse.minScores.performance).toBeGreaterThanOrEqual(0.95);
    expect(real.lighthouse.runs % 2).toBe(1);
  });

  /** A copy of the valid file with the value at `path` replaced (deleted for `undefined`). */
  function edited(path: readonly string[], value: unknown): unknown {
    const copy = structuredClone(valid) as Record<string, unknown>;
    let at = copy;
    for (const key of path.slice(0, -1)) {
      at = at[key] as Record<string, unknown>;
    }
    const last = path.at(-1) ?? '';
    if (value === undefined) {
      Reflect.deleteProperty(at, last);
    } else {
      at[last] = value;
    }
    return copy;
  }

  it('names the broken field in every case', () => {
    const cases: [unknown, string][] = [
      [null, 'must be a JSON object'],
      [[], 'must be a JSON object'],
      [{ ...valid, extra: 1 }, '$.extra is not a budget field (shell, lighthouse)'],
      [{ lighthouse: valid.lighthouse }, '"shell" must be an object'],
      [{ shell: valid.shell }, '"lighthouse" must be an object'],
      [
        edited(['shell', 'bytes'], 1),
        'shell.bytes is not a budget field (scriptKb, styleKb, fontsKb)',
      ],
      [edited(['shell', 'scriptKb'], 0), 'shell.scriptKb must be a whole number of at least 1'],
      [edited(['shell', 'styleKb'], 1.5), 'shell.styleKb must be a whole number of at least 1'],
      [edited(['shell', 'fontsKb'], '9'), 'shell.fontsKb must be a whole number of at least 1'],
      [edited(['lighthouse', 'runs'], 4), 'lighthouse.runs must be odd'],
      [edited(['lighthouse', 'runs'], 0), 'lighthouse.runs must be a whole number of at least 1'],
      [
        edited(['lighthouse', 'other'], 0),
        'lighthouse.other is not a budget field (runs, minScores)',
      ],
      [edited(['lighthouse', 'minScores'], 1), '"minScores" must be an object'],
      [
        edited(['lighthouse', 'minScores', 'seo'], 1),
        'lighthouse.minScores.seo is not a budget field (performance, accessibility, best-practices)',
      ],
      [
        edited(['lighthouse', 'minScores', 'performance'], 0),
        'lighthouse.minScores.performance must be a number above 0 and up to 1',
      ],
      [
        edited(['lighthouse', 'minScores', 'accessibility'], 1.01),
        'lighthouse.minScores.accessibility must be a number above 0 and up to 1',
      ],
      [
        edited(['lighthouse', 'minScores', 'best-practices'], undefined),
        'lighthouse.minScores.best-practices must be a number above 0 and up to 1',
      ],
    ];
    for (const [input, message] of cases) {
      expect(() => parseBudgets(input), message).toThrow(message);
    }
  });

  it('accepts one run and a score of exactly 1', () => {
    const edge = edited(['lighthouse', 'runs'], 1) as typeof valid;
    edge.lighthouse.minScores.performance = 1;
    expect(parseBudgets(edge).lighthouse.runs).toBe(1);
  });

  it('reports a file that is missing or not JSON', () => {
    const root = createTempRoot();
    roots.push(root);
    expect(() => readBudgets(root.root)).toThrow(`${BUDGETS_FILE}: `);
    root.write(BUDGETS_FILE, '{ nope');
    expect(() => readBudgets(root.root)).toThrow(`${BUDGETS_FILE}: `);
    expect(() => readBudgets(root.root)).toThrow(/JSON/);
  });
});

describe('sizes', () => {
  it('measures gzip at level 9, deterministically', () => {
    const text = Buffer.from('stuffcloud '.repeat(500));
    expect(gzipBytes(text)).toBe(gzipSync(text, { level: 9 }).length);
    expect(gzipBytes(text)).toBeLessThan(text.length / 10);
    expect(gzipBytes(text)).toBe(gzipBytes(text));
    expect(gzipBytes(new Uint8Array(0))).toBe(gzipSync(Buffer.alloc(0), { level: 9 }).length);
  });

  it('reads the tags of index.html: scripts, preloads, stylesheets, nothing else', () => {
    expect(shellLinks(HTML)).toEqual({
      script: ['/assets/index-a.js', '/assets/core-a.js'],
      style: ['/assets/app-a.css'],
    });
    const ignored = `<script>inline()</script><script src="/x.js"></script><script type="module">m()</script>
      <link rel="preload" href="/assets/f.woff2"><link rel="stylesheet"><link rel="icon" href="/i.ico">`;
    expect(shellLinks(ignored)).toEqual({ script: [], style: [] });
  });

  it('reads tags and attributes in any letter case', () => {
    const shouting = `<SCRIPT TYPE="module" SRC="/a.js"></SCRIPT><LINK REL="ModulePreload" HREF="/b.js"><Link Rel="Stylesheet" Href="/c.css">`;
    expect(shellLinks(shouting)).toEqual({ script: ['/a.js', '/b.js'], style: ['/c.css'] });
  });

  it('finds the files a stylesheet names, same-origin only', () => {
    const css =
      'a{background:url(/assets/a.svg)}b{src:url( "/assets/b.woff2" )}c{x:url(\'/assets/c.woff\')}d{x:url(//cdn.example/e.woff2)}e{x:url(data:image/png;base64,AAAA)}f{x:url(relative.png)}';
    expect(stylesheetFiles(css)).toEqual(['assets/a.svg', 'assets/b.woff2', 'assets/c.woff']);
    expect(stylesheetFiles('body{color:red}')).toEqual([]);
  });
});

describe('readBuild', () => {
  it('lists the files without source maps and the manifest', () => {
    const build = readBuild(makeDist(app()));
    expect(build.files).toContain('assets/core-a.js');
    expect(build.files).toContain('index.html');
    expect(build.files).not.toContain('assets/ignored.js.map');
    expect(build.files.some((name) => name.startsWith('.vite/'))).toBe(false);
    expect(Object.keys(build.chunks)).toContain('index.html');
  });

  it('asks for a build with a manifest', () => {
    const dist = mkdtempSync(join(tmpdir(), 'stuffcloud-perf-'));
    created.push(dist);
    expect(() => readBuild(dist)).toThrow(
      /manifest\.json is missing: build with `vite build --manifest`/,
    );
  });

  it('rejects a manifest that is not an object', () => {
    const dist = makeDist(app());
    writeFileSync(join(dist, '.vite', 'manifest.json'), '[]');
    expect(() => readBuild(dist)).toThrow(/is not a Vite manifest/);
  });
});

describe('measureShell', () => {
  it('sums scripts, stylesheets and the fonts of the stylesheets', () => {
    const dist = makeDist(app());
    const shell = measureShell(readBuild(dist));
    expect(names(shell.script)).toEqual(['assets/index-a.js', 'assets/core-a.js']);
    expect(names(shell.style)).toEqual(['assets/app-a.css']);
    expect(names(shell.fonts)).toEqual(['assets/font-a.woff2']);
    const core = readFileSync(join(dist, 'assets/core-a.js'));
    expect(shell.script[1]).toEqual({
      file: 'assets/core-a.js',
      bytes: core.length,
      gzipBytes: gzipSync(core, { level: 9 }).length,
    });
  });

  it('counts a file linked twice once, and only fonts of the stylesheets', () => {
    const html = `${HTML}<script type="module" src="/assets/index-a.js"></script>`;
    const files = {
      'assets/app-a.css':
        'a{x:url(/assets/index-a.js)}b{x:url(/assets/font-a.woff2)}b{x:url(/assets/font-a.woff2)}',
    };
    const shell = measureShell(
      readBuild(makeDist({ ...app(), html, files: { ...app().files, ...files } })),
    );
    expect(names(shell.script)).toEqual(['assets/index-a.js', 'assets/core-a.js']);
    expect(names(shell.fonts)).toEqual(['assets/font-a.woff2']);
  });

  it('refuses a link that leaves the origin, and a file the build lacks', () => {
    const external = HTML.replace('/assets/core-a.js', 'https://cdn.example/core.js');
    expect(() => measureShell(readBuild(makeDist({ ...app(), html: external })))).toThrow(
      'index.html links https://cdn.example/core.js: only same-origin absolute paths are allowed',
    );
    const protocolRelative = HTML.replace('/assets/core-a.js', '//cdn.example/core.js');
    expect(() => measureShell(readBuild(makeDist({ ...app(), html: protocolRelative })))).toThrow(
      /only same-origin absolute paths/,
    );
    const missing = HTML.replace('core-a.js', 'gone-a.js');
    expect(() => measureShell(readBuild(makeDist({ ...app(), html: missing })))).toThrow(
      'assets/gone-a.js is named by the build but does not exist',
    );
  });

  it('refuses a name that is a directory', () => {
    const html = HTML.replace('/assets/core-a.js', '/assets');
    expect(() => measureShell(readBuild(makeDist({ ...app(), html })))).toThrow(
      'assets is named by the build but does not exist',
    );
  });
});

describe('measureTool', () => {
  const build = (): BuildOutput => readBuild(makeDist(app()));

  it('takes the page chunk, the chunks the shell did not fetch and their CSS, and leaves the shell out', () => {
    const b = build();
    const sizes = measureTool(b, measureShell(b), 'alpha');
    expect(names(sizes.script)).toEqual([
      'assets/alpha-a.css',
      'assets/alpha-a.js',
      'assets/shared-a.js',
    ]);
    expect(sizes.assets).toEqual([]);
  });

  it('follows dynamic imports and finds workers and what workers load by file name', () => {
    const b = build();
    const sizes = measureTool(b, measureShell(b), 'beta');
    expect(names(sizes.script)).toEqual([
      'assets/beta-a.js',
      'assets/lazy-a.js',
      'assets/shared-a.js',
    ]);
    expect(names(sizes.assets)).toEqual(['assets/engine-a.js', 'assets/worker-a.js']);
  });

  it('does not count a chunk the manifest lists as an asset, and does not loop on a cycle', () => {
    const spec = app({
      files: {
        'assets/beta-a.js': 'new Worker("worker-a.js"); import("lazy-a.js"); import("shared-a.js")',
        'assets/shared-a.js': 'import("beta-a.js")',
      },
    });
    const looping: DistSpec = {
      ...spec,
      chunks: {
        ...spec.chunks,
        '_shared-a.js': { file: 'assets/shared-a.js', imports: ['src/tools/beta/Tool.svelte'] },
      },
    };
    const b = readBuild(makeDist(looping));
    const sizes = measureTool(b, measureShell(b), 'beta');
    expect(names(sizes.script)).toEqual([
      'assets/beta-a.js',
      'assets/lazy-a.js',
      'assets/shared-a.js',
    ]);
    expect(names(sizes.assets)).toEqual(['assets/engine-a.js', 'assets/worker-a.js']);
  });

  it('fails for a tool the build has no chunk for', () => {
    const b = build();
    expect(() => measureTool(b, measureShell(b), 'gamma')).toThrow(
      'tool gamma: the build has no chunk for src/tools/gamma/Tool.svelte; the manifest must load ./Tool.svelte',
    );
  });

  it('ignores files that are not scripts when it looks for names', () => {
    const spec = app({
      files: { 'assets/alpha-a.css': '.a{background:url(/assets/engine-a.js)}' },
    });
    const b = readBuild(makeDist(spec));
    expect(measureTool(b, measureShell(b), 'alpha').assets).toEqual([]);
  });

  it('shares nothing with the shell: a chunk the first page load fetches is not counted again', () => {
    const b = build();
    const sizes = measureTool(b, measureShell(b), 'alpha');
    expect(names(sizes.script)).not.toContain('assets/core-a.js');
    expect(names(sizes.script)).not.toContain('assets/app-a.css');
  });
});

describe('evaluate', () => {
  function measurement(gzip: number, limitKb: number): Measurement {
    return {
      scope: 'shell',
      metric: 'script',
      gzipBytes: gzip,
      limitBytes: limitKb * KIB,
      files: [],
    };
  }

  it('passes below and exactly at the limit, fails one byte over', () => {
    const findings = evaluate([
      measurement(KIB - 1, 1),
      measurement(KIB, 1),
      measurement(KIB + 1, 1),
      measurement(0, 0),
      measurement(1, 0),
    ]);
    expect(findings.map((finding) => finding.ok)).toEqual([true, true, false, true, false]);
  });
});

describe('check', () => {
  const limits = (alpha: ToolLimits, beta: ToolLimits): Map<string, ToolLimits> =>
    new Map([
      ['beta', beta],
      ['alpha', alpha],
    ]);
  const roomy: ToolLimits = { scriptKb: 100, assetsKb: 100 };

  it('reports the shell and every tool, tools sorted by id', () => {
    const findings = check(readBuild(makeDist(app())), BUDGETS, limits(roomy, roomy));
    expect(findings.map((finding) => `${finding.scope}/${finding.metric}`)).toEqual([
      'shell/script',
      'shell/style',
      'shell/fonts',
      'tool alpha/script',
      'tool alpha/assets',
      'tool beta/script',
      'tool beta/assets',
    ]);
    expect(findings.every((finding) => finding.ok)).toBe(true);
    expect(findings[0]?.limitBytes).toBe(100 * KIB);
  });

  it('fails exactly one byte over a tool limit, in script and in assets', () => {
    const solo = (script: Buffer, engine: Buffer): BuildOutput => {
      const spec = app({
        files: {
          'assets/alpha-a.js': script,
          'assets/beta-a.js': 'new Worker("engine-a.js")',
          'assets/engine-a.js': engine,
        },
      });
      const chunks: DistSpec['chunks'] = {
        ...spec.chunks,
        'src/tools/alpha/Tool.svelte': { file: 'assets/alpha-a.js' },
        'src/tools/beta/Tool.svelte': { file: 'assets/beta-a.js' },
      };
      return readBuild(makeDist({ ...spec, chunks, files: { ...app().files, ...spec.files } }));
    };
    const only = (
      build: BuildOutput,
      alpha: ToolLimits,
      beta: ToolLimits,
      id: string,
      metric: string,
    ): Finding | undefined =>
      check(build, BUDGETS, limits(alpha, beta)).find(
        (finding) => finding.scope === `tool ${id}` && finding.metric === metric,
      );
    // alpha's whole script is its one chunk; beta's whole assets are the engine behind its worker file name.
    const at = solo(gzipping(KIB, 2), gzipping(2 * KIB, 3));
    const over = solo(gzipping(KIB + 1, 2), gzipping(2 * KIB + 1, 3));
    const under = solo(gzipping(KIB - 1, 2), gzipping(2 * KIB - 1, 3));
    const tight: ToolLimits = { scriptKb: 1, assetsKb: 2 };
    const workerBytes = gzipBytes(Buffer.from('new Worker("engine-a.js")'));
    expect(only(at, tight, tight, 'alpha', 'script')).toMatchObject({ gzipBytes: KIB, ok: true });
    expect(only(over, tight, tight, 'alpha', 'script')).toMatchObject({
      gzipBytes: KIB + 1,
      ok: false,
    });
    expect(only(under, tight, tight, 'alpha', 'script')).toMatchObject({
      gzipBytes: KIB - 1,
      ok: true,
    });
    // beta's script is the 25-byte worker line; its assets are the engine alone.
    expect(only(at, tight, tight, 'beta', 'assets')).toMatchObject({
      gzipBytes: 2 * KIB,
      ok: true,
    });
    expect(only(over, tight, tight, 'beta', 'assets')).toMatchObject({
      gzipBytes: 2 * KIB + 1,
      ok: false,
    });
    expect(only(under, tight, tight, 'beta', 'assets')).toMatchObject({
      gzipBytes: 2 * KIB - 1,
      ok: true,
    });
    expect(only(at, tight, tight, 'beta', 'script')).toMatchObject({
      gzipBytes: workerBytes,
      ok: true,
    });
  });

  it('applies the limit to the exact gzip total of the shell: equal passes, one byte more fails', () => {
    const exact = gzipping(KIB, 11);
    const html = `<script type="module" src="/a.js"></script>`;
    const make = (script: Buffer): BuildOutput =>
      readBuild(makeDist({ html, chunks: {}, files: { 'a.js': script } }));
    const budgets = (kb: number): Budgets => ({
      ...BUDGETS,
      shell: { ...BUDGETS.shell, scriptKb: kb },
    });
    const script = (kb: number, script: Buffer): Finding | undefined =>
      check(make(script), budgets(kb), new Map()).find((finding) => finding.metric === 'script');
    expect(script(1, exact)?.ok).toBe(true);
    expect(script(1, exact)?.gzipBytes).toBe(KIB);
    expect(script(1, gzipping(KIB + 1, 11))?.ok).toBe(false);
    expect(script(1, gzipping(KIB - 1, 11))?.ok).toBe(true);
  });
});

describe('reports', () => {
  const files: Sized[] = [{ file: 'assets/a.js', bytes: 5000, gzipBytes: 2048 }];
  const over: Measurement = {
    scope: 'tool alpha',
    metric: 'script',
    gzipBytes: 2048,
    limitBytes: 1024,
    files,
  };
  const within: Measurement = {
    scope: 'shell',
    metric: 'style',
    gzipBytes: 512,
    limitBytes: 1024,
    files: [],
  };

  it('prints a table with exact sizes and limits', () => {
    expect(formatTable(evaluate([within, over]))).toBe(
      [
        '| | Scope | Metric | gzip size | Budget |',
        '|---|---|---|---|---|',
        '| ok | shell | style | 512 B (0.50 KiB) | 1024 B (1.00 KiB) |',
        '| OVER | tool alpha | script | 2048 B (2.00 KiB) | 1024 B (1.00 KiB) |',
      ].join('\n'),
    );
  });

  it('names every exceeded budget, its overshoot, its files and the way out', () => {
    const message = formatFailures(evaluate([within, over]));
    expect(message).toContain('1 performance budget exceeded:');
    expect(message).toContain(
      '- tool alpha, script: 2048 B gzip (2.00 KiB) is 1024 B over the budget of 1024 B (1.00 KiB)',
    );
    expect(message).toContain('    assets/a.js: 2048 B gzip, 5000 B raw');
    expect(message).not.toContain('shell, style');
    expect(message).toContain('perf-budgets.json');
    expect(formatFailures(evaluate([over, { ...over, scope: 'tool beta' }]))).toContain(
      '2 performance budgets exceeded:',
    );
  });
});

describe('readToolLimits', () => {
  it('reads the budget of every real tool', { timeout: 30_000 }, async () => {
    const limits = await readToolLimits();
    expect(limits.get('qr')).toBeDefined();
    expect(limits.size).toBeGreaterThanOrEqual(25);
    for (const [id, limit] of limits) {
      expect(Number.isInteger(limit.scriptKb), id).toBe(true);
      expect(Number.isInteger(limit.assetsKb), id).toBe(true);
    }
    expect(APP_ROOT).toBe(appRoot);
  });

  it('reads a tree of its own, and names a manifest without a budget', async () => {
    const root = createTempRoot();
    roots.push(root);
    root.write(
      'src/tools/alpha/manifest.ts',
      manifestSource('alpha', { budget: '{ scriptKb: 7, assetsKb: 3 }' }),
    );
    addTexts(root, 'alpha');
    expect([...(await readToolLimits(root.root))]).toEqual([
      ['alpha', { scriptKb: 7, assetsKb: 3 }],
    ]);
    root.write('src/tools/broken/manifest.ts', 'export default {};\n');
    await expect(readToolLimits(root.root)).rejects.toThrow(
      'src/tools/broken/manifest.ts has no default export with an id and a budget',
    );
  });
});

describe('runBudgetCli', () => {
  function io(): {
    out: string[];
    err: string[];
    io: { out: (m: string) => void; err: (m: string) => void };
  } {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (m) => out.push(m), err: (m) => err.push(m) } };
  }

  /** A tree with one tool `alpha` whose budgets are `scriptKb`/`assetsKb`, and the shell budgets of `shellKb`. */
  function tree(scriptKb: number, assetsKb: number, shellKb = 100): TempRoot {
    const root = createTempRoot();
    roots.push(root);
    root.write(
      'src/tools/alpha/manifest.ts',
      manifestSource('alpha', {
        budget: `{ scriptKb: ${String(scriptKb)}, assetsKb: ${String(assetsKb)} }`,
      }),
    );
    addTexts(root, 'alpha');
    root.write(
      BUDGETS_FILE,
      JSON.stringify({
        shell: { scriptKb: shellKb, styleKb: shellKb, fontsKb: shellKb },
        lighthouse: BUDGETS.lighthouse,
      }),
    );
    return root;
  }

  it('prints usage for unknown, valueless or empty arguments', async () => {
    for (const args of [['--nope', 'x'], ['--dist'], ['--summary', ''], ['stray']]) {
      const run = io();
      expect(await runBudgetCli(args, run.io, tree(10, 10).root)).toBe(2);
      expect(run.err).toEqual([
        'usage: check-budgets [--dist <build directory>] [--summary <markdown file>]',
      ]);
    }
  });

  it('exits 0 when everything is within budget, and appends the table to the summary', async () => {
    const root = tree(50, 50);
    const dist = makeDist({
      ...app(),
      chunks: { ...app().chunks, 'src/tools/alpha/Tool.svelte': { file: 'assets/alpha-a.js' } },
    });
    const summary = join(dist, 'summary.md');
    writeFileSync(summary, 'before\n');
    const run = io();
    expect(await runBudgetCli(['--dist', dist, '--summary', summary], run.io, root.root)).toBe(0);
    expect(run.err).toEqual([]);
    expect(run.out[0]).toContain('| ok | shell | script |');
    expect(run.out.at(-1)).toBe('all 5 budgets are met');
    const text = readFileSync(summary, 'utf8');
    expect(text.startsWith('before\n## Performance budgets\n\n| |')).toBe(true);
  });

  it('exits 1 and explains when a budget is exceeded', async () => {
    const root = tree(10, 10, 1);
    const dist = makeDist({
      ...app(),
      chunks: { ...app().chunks, 'src/tools/alpha/Tool.svelte': { file: 'assets/alpha-a.js' } },
      files: { ...app().files, 'assets/index-a.js': noise(4000, 5) },
    });
    const run = io();
    expect(await runBudgetCli(['--dist', dist], run.io, root.root)).toBe(1);
    expect(run.out[0]).toContain('| OVER | shell | script |');
    expect(run.err[0]).toContain('performance budget');
    expect(run.err[0]).toContain('assets/index-a.js');
    expect(run.out.join('\n')).not.toContain('are met');
  });

  it('exits 1 with the reason when the build or a budget file is unusable', async () => {
    const root = tree(10, 10);
    const empty = mkdtempSync(join(tmpdir(), 'stuffcloud-perf-'));
    created.push(empty);
    const run = io();
    expect(await runBudgetCli(['--dist', empty], run.io, root.root)).toBe(1);
    expect(run.err[0]).toContain('manifest.json is missing');
    const broken = io();
    root.write(BUDGETS_FILE, '[]');
    expect(await runBudgetCli(['--dist', makeDist(app())], broken.io, root.root)).toBe(1);
    expect(broken.err[0]).toContain('must be a JSON object');
  });

  it('defaults to dist-perf of the app root, which does not exist here', async () => {
    const run = io();
    expect(await runBudgetCli([], run.io, tree(10, 10).root)).toBe(1);
    expect(run.err[0]).toContain('dist-perf');
  });
});
