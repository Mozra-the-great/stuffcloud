// Large-PDF measurement of the PDF tools (issue #15, T-10): a 100 MB PDF with 500 pages is merged
// with a small one and its pages are drawn, in a real Chromium against the built app, while the page
// is watched for frames that take long. Prints one JSON object; nothing is asserted here (the
// e2e suite holds the regression test), the numbers go into the pull request.
//
//   pnpm e2e:build && node perf/pdf-large.ts [--pages 500] [--megabytes 100] [--streams 1]

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { PDFDocument, PDFName, rgb, StandardFonts } from 'pdf-lib';
import { preview } from 'vite';

const PORT = 4198;
const APP_ROOT = resolve(import.meta.dirname, '..');

function argument(name: string, fallback: number): number {
  const at = process.argv.indexOf(`--${name}`);
  const value = at === -1 ? undefined : Number(process.argv[at + 1]);
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** A PDF of `pages` pages and about `megabytes` MB: every page carries its share as `streams` unused form XObjects (many small objects are what scanned or exported files look like). */
async function bigPdf(pages: number, megabytes: number, streams: number): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const perStream = Math.floor((megabytes * 1024 * 1024) / pages / streams);
  const noise = new Uint8Array(perStream);
  for (let index = 0; index < pages; index += 1) {
    const page = document.addPage([595, 842]);
    page.drawText(`Page ${String(index + 1)}`, { x: 50, y: 700, size: 30, font });
    page.drawRectangle({ x: 50, y: 50, width: 100, height: 100, color: rgb(0, 0, 0) });
    const forms: Record<string, ReturnType<typeof document.context.register>> = {};
    for (let stream = 0; stream < streams; stream += 1) {
      // High-entropy bytes (xorshift), so nothing compresses and the file really is that large.
      let state = ((index + 1) * 2654435761 + stream * 40503) | 1;
      for (let at = 0; at < perStream; at += 4) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        noise[at] = state & 255;
        noise[at + 1] = (state >>> 8) & 255;
        noise[at + 2] = (state >>> 16) & 255;
        noise[at + 3] = (state >>> 24) & 255;
      }
      forms[`Unused${String(stream)}`] = document.context.register(
        document.context.stream(noise.slice(), {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [0, 0, 10, 10],
        }),
      );
    }
    page.node.Resources()?.set(PDFName.of('XObject'), document.context.obj(forms));
  }
  return document.save({ useObjectStreams: false });
}

interface Watch {
  readonly worstFrameMs: number;
  readonly frames: number;
  readonly longTasks: number;
  readonly longestTaskMs: number;
  readonly blockedMs: number;
}

/** Starts counting frames and long tasks on the page; the returned function stops and reports. */
async function watch(page: Page): Promise<() => Promise<Watch>> {
  await page.evaluate(() => {
    const state = {
      last: performance.now(),
      worst: 0,
      frames: 0,
      tasks: [] as number[],
      stopped: false,
    };
    const tick = (): void => {
      if (state.stopped) {
        return;
      }
      const now = performance.now();
      state.worst = Math.max(state.worst, now - state.last);
      state.last = now;
      state.frames += 1;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        state.tasks.push(entry.duration);
      }
    }).observe({ type: 'longtask', buffered: true });
    (window as unknown as { __watch: typeof state }).__watch = state;
  });
  return async () =>
    page.evaluate(() => {
      const state = (
        window as unknown as {
          __watch: { worst: number; frames: number; tasks: number[]; stopped: boolean };
        }
      ).__watch;
      state.stopped = true;
      return {
        worstFrameMs: Math.round(state.worst),
        frames: state.frames,
        longTasks: state.tasks.length,
        longestTaskMs: Math.round(Math.max(0, ...state.tasks)),
        blockedMs: Math.round(state.tasks.reduce((sum, task) => sum + task, 0)),
      };
    });
}

async function main(): Promise<void> {
  const pages = argument('pages', 500);
  const megabytes = argument('megabytes', 100);
  const folder = mkdtempSync(join(tmpdir(), 'stuffcloud-pdf-perf-'));
  const server = await preview({
    root: APP_ROOT,
    configFile: resolve(APP_ROOT, 'e2e/vite.config.ts'),
    preview: { host: '127.0.0.1', port: PORT, strictPort: true },
  });
  const browser = await chromium.launch();
  try {
    const started = performance.now();
    const big = await bigPdf(pages, megabytes, argument('streams', 1));
    const generateMs = Math.round(performance.now() - started);
    const bigPath = join(folder, 'big.pdf');
    const smallPath = join(folder, 'small.pdf');
    writeFileSync(bigPath, big);
    const small = await PDFDocument.create();
    for (let index = 0; index < 5; index += 1) {
      small.addPage([300, 400]);
    }
    writeFileSync(smallPath, await small.save());

    const result: Record<string, unknown> = {
      pages,
      streamsPerPage: argument('streams', 1),
      fileMegabytes: Math.round((big.length / 1024 / 1024) * 10) / 10,
      generateMs,
      chromium: browser.version(),
    };

    // Merge: the big file and a small one.
    {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${String(PORT)}/tools/pdf-merge`);
      await page.locator('input[type="file"]').setInputFiles([bigPath, smallPath]);
      const readyAt = performance.now();
      await page.waitForFunction(
        () =>
          document.querySelectorAll('.meta').length === 2 &&
          !document.body.textContent.includes('Reading file'),
        undefined,
        { timeout: 120_000 },
      );
      const inspectMs = Math.round(performance.now() - readyAt);
      const stop = await watch(page);
      const mergeStart = performance.now();
      await page.getByRole('button', { name: 'Merge', exact: true }).click();
      await page.getByRole('link', { name: 'Download merged.pdf' }).waitFor({ timeout: 300_000 });
      const mergeMs = Math.round(performance.now() - mergeStart);
      result['merge'] = {
        ...(await stop()),
        mergeMs,
        inspectMsAfterAdd: inspectMs,
        resultText: await page.locator('.live [role="status"]').innerText(),
      };
      await page.close();
    }

    // The page editor: open the big file, draw all pictures.
    {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${String(PORT)}/tools/pdf-pages`);
      const stop = await watch(page);
      const openStart = performance.now();
      await page.locator('input[type="file"]').setInputFiles(bigPath);
      await page.getByRole('option').first().waitFor({ timeout: 120_000 });
      const openMs = Math.round(performance.now() - openStart);
      await page.waitForFunction(
        (count) => document.querySelectorAll('[role="option"] canvas').length >= count,
        pages,
        { timeout: 600_000 },
      );
      const picturesMs = Math.round(performance.now() - openStart);
      // Delete half the pages and save.
      await page.getByRole('option').first().focus();
      await page.keyboard.press('Control+a');
      await page.getByRole('button', { name: 'Select none', exact: true }).click();
      const saveStart = performance.now();
      await page.getByRole('button', { name: 'Save PDF', exact: true }).click();
      await page
        .getByRole('link', { name: /^Download big_edited\.pdf$/ })
        .waitFor({ timeout: 300_000 });
      const saveMs = Math.round(performance.now() - saveStart);
      result['pages'] = {
        ...(await stop()),
        openMs,
        picturesMs,
        saveMs,
        resultText: await page.locator('.live [role="status"]').innerText(),
      };
      await page.close();
    }

    process.stdout.write(`${JSON.stringify(result, undefined, 2)}\n`);
  } finally {
    await browser.close();
    await server.close();
    rmSync(folder, { recursive: true, force: true });
  }
}

await main();
