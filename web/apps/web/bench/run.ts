/**
 * Driver of the animation benchmark (ADR 0008). Starts the Vite dev server and a headless
 * Chrome, talks to it over the DevTools protocol and prints Markdown tables.
 *
 *   node bench/run.ts bench   # frame budget and main-thread cost of every variant
 *   node bench/run.ts verify  # the shipped Mascot in the gallery: reduced motion, off-screen,
 *                             # layout work, integer scaling
 *   node bench/run.ts size    # minified and gzip size of each variant's code
 *
 * Needs a Chrome or Chromium (`CHROME_PATH` or `--chrome`); adds no dependency. The parts with
 * logic are in `report.ts`, `cdp.ts` and `stats.ts` and are unit tested; this file only wires
 * processes together.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import { build, createServer, type ViteDevServer } from 'vite';
import {
  browserSocketUrl,
  CdpClient,
  evaluated,
  parseDevToolsPort,
  parseMetrics,
  stringField,
  type SocketLike,
} from './cdp.ts';
import {
  chromeCandidates,
  countersOf,
  findChrome,
  formatRows,
  formatSizes,
  parseArgs,
  type BenchRow,
  type CliOptions,
  type SizeRow,
} from './report.ts';
import type { RunOptions, RunResult } from './runner.ts';
import { metricsDelta } from './stats.ts';

const appRoot = resolve(import.meta.dirname, '..');

/** A DevTools duration counter (seconds) as milliseconds with one decimal. */
function seconds(value: number | undefined): string {
  return value === undefined ? 'n/a' : (value * 1000).toFixed(1);
}

function write(text: string): void {
  process.stdout.write(`${text}\n`);
}

class Browser {
  readonly client: CdpClient;
  readonly sessionId: string;
  private readonly process: ChildProcess;
  private readonly profile: string;

  private constructor(
    client: CdpClient,
    sessionId: string,
    process: ChildProcess,
    profile: string,
  ) {
    this.client = client;
    this.sessionId = sessionId;
    this.process = process;
    this.profile = profile;
  }

  static async launch(chrome: string): Promise<Browser> {
    const profile = mkdtempSync(join(tmpdir(), 'stuffcloud-bench-'));
    const child = spawn(
      chrome,
      [
        '--headless=new',
        '--remote-debugging-port=0',
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-background-timer-throttling',
        '--window-size=1280,900',
        'about:blank',
      ],
      { stdio: 'ignore' },
    );
    const portFile = join(profile, 'DevToolsActivePort');
    for (let attempt = 0; attempt < 100 && !existsSync(portFile); attempt += 1) {
      await sleep(100);
    }
    if (!existsSync(portFile)) {
      child.kill();
      throw new Error('Chrome did not open a DevTools port');
    }
    // Only the validated port number leaves the file; the socket address comes from the browser.
    const port = parseDevToolsPort(readFileSync(portFile, 'utf8'));
    const version: unknown = await (
      await fetch(`http://127.0.0.1:${String(port)}/json/version`)
    ).json();
    const socket = new WebSocket(browserSocketUrl(version, port));
    await new Promise<void>((done, fail) => {
      socket.onopen = (): void => {
        done();
      };
      socket.onerror = (): void => {
        fail(new Error('cannot connect to Chrome'));
      };
    });
    const client = new CdpClient(socket as unknown as SocketLike);
    const targetId = stringField(
      await client.call('Target.createTarget', { url: 'about:blank' }),
      'targetId',
    );
    const sessionId = stringField(
      await client.call('Target.attachToTarget', { targetId, flatten: true }),
      'sessionId',
    );
    const browser = new Browser(client, sessionId, child, profile);
    for (const domain of ['Page', 'Runtime', 'Performance']) {
      await browser.call(`${domain}.enable`);
    }
    return browser;
  }

  async call(method: string, params: object = {}): Promise<unknown> {
    return this.client.call(method, params, this.sessionId);
  }

  async evaluate(expression: string): Promise<unknown> {
    return evaluated(
      await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
    );
  }

  async open(url: string, ready: string): Promise<void> {
    await this.call('Page.navigate', { url });
    let last = 'no answer';
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await sleep(100);
      try {
        const answer = await this.evaluate(ready);
        if (answer === true) {
          return;
        }
        last = `readiness check returned ${JSON.stringify(answer)}`;
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
      }
    }
    throw new Error(`${url} did not become ready (${last})`);
  }

  async metrics(): Promise<Readonly<Record<string, number>>> {
    return parseMetrics(await this.call('Performance.getMetrics'));
  }

  async close(): Promise<void> {
    this.client.close();
    this.process.kill();
    await sleep(500);
    rmSync(this.profile, { recursive: true, force: true });
  }
}

async function serve(): Promise<ViteDevServer> {
  const server = await createServer({
    configFile: resolve(appRoot, 'vite.config.ts'),
    root: appRoot,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  });
  await server.listen();
  return server;
}

function baseUrl(server: ViteDevServer): string {
  const address = server.httpServer?.address();
  if (address === null || address === undefined || typeof address === 'string') {
    throw new Error('dev server has no address');
  }
  return `http://127.0.0.1:${String(address.port)}`;
}

async function runBench(browser: Browser, base: string, cli: CliOptions): Promise<void> {
  const rows: BenchRow[] = [];
  const ready = 'typeof window.__bench === "object"';
  for (const throttle of cli.throttles) {
    await browser.call('Emulation.setCPUThrottlingRate', { rate: throttle });
    for (const count of cli.counts) {
      for (const variant of cli.variants) {
        const options = (sample: boolean): RunOptions => ({
          variant,
          count,
          scale: cli.scale,
          durationMs: cli.durationMs,
          sample,
        });
        // Idle pass: nothing but the variant touches the main thread; the browser counters show its cost.
        await browser.open(`${base}/bench/index.html`, ready);
        await browser.evaluate(
          `window.__bench.start(${JSON.stringify(options(false))}).then(() => true)`,
        );
        const before = await browser.metrics();
        await browser.evaluate('window.__bench.finish().then(() => true)');
        const after = await browser.metrics();
        // Sampling pass: a requestAnimationFrame sampler records frame intervals.
        await browser.open(`${base}/bench/index.html`, ready);
        const result = (await browser.evaluate(
          `window.__bench.run(${JSON.stringify(options(true))})`,
        )) as RunResult;
        if (result.frames === null) {
          throw new Error('sampling pass returned no frame statistics');
        }
        rows.push({
          variant,
          count,
          throttle,
          ...countersOf(metricsDelta(before, after), cli.durationMs),
          frames: result.frames,
          layoutShift: result.layoutShift,
          longTasks: result.longTasks.count,
          animations: result.runningAnimations,
        });
      }
    }
  }
  write(formatRows(rows));
}

async function runVerify(browser: Browser, base: string): Promise<void> {
  const gallery = `${base}/gallery.html`;
  const ready = 'document.querySelectorAll("[data-mascot]").length > 0';
  const inspect = `(() => {
    const all = [...document.querySelectorAll('[data-mascot]')];
    const images = all.map((host) => host.querySelector('img'));
    const style = (image) => getComputedStyle(image);
    const inView = (host) => {
      const box = host.getBoundingClientRect();
      return box.bottom >= 0 && box.top <= innerHeight;
    };
    const motion = (host) => host.dataset.motion;
    const mascotAnimations = document.getAnimations().filter((a) => a.effect?.target?.closest('[data-mascot]'));
    return {
      mascots: all.length,
      running: all.filter((host) => motion(host) === 'running').length,
      paused: all.filter((host) => motion(host) === 'paused').length,
      still: all.filter((host) => motion(host) === 'still').length,
      mascotAnimations: mascotAnimations.length,
      runningMascotAnimations: mascotAnimations.filter((a) => a.playState === 'running').length,
      viewport: innerHeight,
      
      timing: [...new Set(images.map((image) => style(image).animationTimingFunction))],
      pixelated: images.every((image) => style(image).imageRendering === 'pixelated'),
      integerScale: images.every((image) => Number.isInteger(image.getBoundingClientRect().width)),
      visibleMatchesState: all.every((host) =>
        inView(host) ? motion(host) !== 'paused' : motion(host) !== 'running' || motion(host) === 'still'),
    };
  })()`;
  write('| check | result |');
  write('|---|---|');

  await browser.open(gallery, ready);
  await sleep(500);
  const normal = (await browser.evaluate(inspect)) as Record<string, unknown>;
  write(`| default: running animations / mascots | ${JSON.stringify(normal)} |`);

  const layoutBefore = await browser.metrics();
  await sleep(2000);
  const layoutAfter = await browser.metrics();
  const delta = metricsDelta(layoutBefore, layoutAfter);
  write(
    `| 2 s of idle animation: layouts / style recalcs / scripts (s) | ${String(delta['LayoutCount'])} / ${String(delta['RecalcStyleCount'])} / ${String(delta['ScriptDuration'])} |`,
  );
  write(
    `| 2 s of idle animation: style recalc time / main-thread task time (ms) | ${seconds(delta['RecalcStyleDuration'])} / ${seconds(delta['TaskDuration'])} |`,
  );

  await browser.evaluate('window.scrollTo(0, document.body.scrollHeight)');
  await sleep(500);
  write(`| scrolled to the bottom | ${JSON.stringify(await browser.evaluate(inspect))} |`);

  await browser.call('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  await browser.open(gallery, ready);
  await sleep(500);
  write(`| prefers-reduced-motion: reduce | ${JSON.stringify(await browser.evaluate(inspect))} |`);
}

async function runSize(): Promise<void> {
  const entries: readonly (readonly [string, string])[] = [
    [
      'kern Mascot.svelte (shipped: CSS keyframes, pause logic)',
      'node_modules/@mozra-the-great/kern/dist/components/Mascot.svelte',
    ],
    ['css-transform variant (bench)', 'bench/variants/css-transform.ts'],
    ['css-sprite and css-strip variants (bench)', 'bench/variants/css-sprite.ts'],
    ['canvas variants (bench)', 'bench/variants/canvas.ts'],
  ];
  const rows: SizeRow[] = [];
  for (const [name, entry] of entries) {
    const output = await build({
      configFile: resolve(appRoot, 'vite.config.ts'),
      root: appRoot,
      logLevel: 'silent',
      // Library builds inline assets; the app emits them as files, so count a hashed file URL
      // instead of the SVG source.
      plugins: [
        {
          name: 'bench-svg-file-url',
          enforce: 'pre',
          load(id: string): string | undefined {
            const match = /([^/\\]+)\.svg\?url$/.exec(id);
            return match === null
              ? undefined
              : `export default ${JSON.stringify(`/assets/${match[1] ?? ''}-AbCd1234.svg`)};`;
          },
        },
      ],
      build: {
        write: false,
        minify: true,
        lib: { entry: resolve(appRoot, entry), formats: ['es'], fileName: 'out' },
        rolldownOptions: { input: resolve(appRoot, entry), external: [/^svelte/] },
      },
    });
    const bundles = Array.isArray(output) ? output : [output];
    let code = '';
    for (const bundle of bundles) {
      if ('output' in bundle) {
        for (const item of bundle.output) {
          if (item.type === 'chunk') {
            code += item.code;
          } else if (item.fileName.endsWith('.css')) {
            code += String(item.source);
          }
        }
      }
    }
    rows.push({
      name,
      minifiedBytes: Buffer.byteLength(code),
      gzipBytes: gzipSync(code).length,
    });
  }
  write(formatSizes(rows));
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  if (cli.mode === 'size') {
    await runSize();
    return;
  }
  const chrome =
    cli.chrome ??
    findChrome(chromeCandidates(process.platform, process.env), (path) => existsSync(path));
  const server = await serve();
  try {
    const browser = await Browser.launch(chrome);
    try {
      const base = baseUrl(server);
      if (cli.mode === 'bench') {
        await runBench(browser, base, cli);
      } else {
        await runVerify(browser, base);
      }
    } finally {
      await browser.close();
    }
  } finally {
    await server.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
