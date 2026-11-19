import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import { sampleFile, sha256Hex, type Sample } from '../support/files.ts';

// The worker pool (`createWorkerPool`, `serveWorker`) in a real browser, driven through the
// test-only `worker-lab` tool: real workers, real transfer of buffers, real termination.

const FILES = [
  sampleFile('alpha.bin', 40_000, 0x1a2b3c4d),
  sampleFile('bravo.bin', 1, 0x2b3c4d5e),
  sampleFile('charlie.bin', 250_000, 0x3c4d5e6f),
  sampleFile('delta.bin', 4_096, 0x4d5e6f70),
  sampleFile('echo.bin', 77_777, 0x5e6f7081),
  sampleFile('foxtrot.bin', 12, 0x6f708192),
] as const;

function expected(file: Sample): string {
  return `${file.name} · ${String(file.buffer.length)} bytes · ${sha256Hex(file.buffer)}`;
}

async function openLab(page: Page): Promise<void> {
  await page.goto('/tools/worker-lab');
  await expect(page.getByRole('heading', { level: 1, name: 'Worker lab' })).toBeVisible();
}

function status(page: Page): ReturnType<Page['getByTestId']> {
  return page.getByTestId('lab-status');
}

function chooseFiles(page: Page, files: readonly Sample[]): Promise<void> {
  return page.locator('input[type="file"]').setInputFiles([...files]);
}

test.describe('worker pool', () => {
  test('hashes a file in a worker and shows the digest', async ({ page, a11y }) => {
    await openLab(page);
    await expect(status(page)).toHaveAttribute('data-status', 'idle');
    expect(page.workers()).toHaveLength(0);

    const [file] = FILES;
    await chooseFiles(page, [file]);

    await expect(status(page)).toHaveText('done · 1 of 1 · workers: 1');
    await expect(page.getByRole('list', { name: 'Digests' }).getByRole('listitem')).toHaveText([
      expected(file),
    ]);
    // The work really ran off the page: the browser reports exactly one dedicated worker.
    expect(page.workers()).toHaveLength(1);
    await a11y.check(page, 'worker lab after a run');
  });

  test('queues more files than workers: two workers, every digest right, progress complete', async ({
    page,
  }) => {
    await openLab(page);
    await chooseFiles(page, FILES);

    await expect(status(page)).toHaveText('done · 6 of 6 · workers: 2');
    const items = page.getByRole('list', { name: 'Digests' }).getByRole('listitem');
    await expect(items).toHaveText(FILES.map(expected));
    expect(page.workers()).toHaveLength(2);
    const bar = page.getByRole('progressbar', { name: 'Progress' });
    await expect(bar).toHaveAttribute('aria-valuemax', '6');
    await expect(bar).toHaveAttribute('aria-valuenow', '6');
  });

  test('runs a second batch on the same workers', async ({ page }) => {
    await openLab(page);
    await chooseFiles(page, FILES.slice(0, 3));
    await expect(status(page)).toHaveText('done · 3 of 3 · workers: 2');
    await chooseFiles(page, FILES.slice(3));
    await expect(status(page)).toHaveText('done · 3 of 3 · workers: 2');
    await expect(page.getByRole('list', { name: 'Digests' }).getByRole('listitem')).toHaveText(
      FILES.slice(3).map(expected),
    );
    expect(page.workers()).toHaveLength(2);
  });

  test('takes a file dropped on the drop zone', async ({ page }) => {
    await openLab(page);
    const [file] = FILES;
    const transfer = await page.evaluateHandle(
      ({ name, bytes }) => {
        const data = new DataTransfer();
        data.items.add(new File([new Uint8Array(bytes)], name));
        return data;
      },
      { name: file.name, bytes: [...file.buffer] },
    );
    await page.getByRole('group', { name: 'Drop files here' }).dispatchEvent('drop', {
      dataTransfer: transfer,
    });
    await expect(page.getByRole('list', { name: 'Digests' }).getByRole('listitem')).toHaveText([
      expected(file),
    ]);
  });

  test('downloads the report as a file that matches what the page shows', async ({ page }) => {
    await openLab(page);
    await chooseFiles(page, FILES.slice(0, 3));
    await expect(status(page)).toHaveText('done · 3 of 3 · workers: 2');

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download report' }).click(),
    ]);

    expect(download.suggestedFilename()).toBe('digests.txt');
    const path = await download.path();
    const lines = (await readFile(path, 'utf8')).split('\n');
    expect(lines).toEqual(
      FILES.slice(0, 3).map(
        (file) => `${file.name}\t${String(file.buffer.length)}\t${sha256Hex(file.buffer)}`,
      ),
    );
  });

  test('keeps the page responsive while a job runs, and cancelling stops its worker', async ({
    page,
  }) => {
    await openLab(page);
    await page.getByRole('button', { name: 'Start a job that never ends' }).click();
    await expect(status(page)).toHaveText('working · 1 of 2 · workers: 1');
    expect(page.workers()).toHaveLength(1);
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeEnabled();

    // Three animation frames in a row: the main thread is not blocked by the worker's job.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                resolve();
              });
            });
          });
        }),
    );

    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(status(page)).toHaveAttribute('data-status', 'cancelled');
    // Cancelling terminates the worker (running code cannot be interrupted any other way).
    await expect.poll(() => page.workers().length).toBe(0);
  });

  test('replaces a cancelled worker: the next job on the same page runs normally', async ({
    page,
  }) => {
    await openLab(page);
    await page.getByRole('button', { name: 'Start a job that never ends' }).click();
    await expect(status(page)).toHaveText('working · 1 of 2 · workers: 1');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(status(page)).toHaveAttribute('data-status', 'cancelled');

    const [, , file] = FILES;
    await chooseFiles(page, [file]);
    await expect(status(page)).toHaveAttribute('data-status', 'done');
    await expect(page.getByRole('list', { name: 'Digests' }).getByRole('listitem')).toHaveText([
      expected(file),
    ]);
    expect(page.workers()).toHaveLength(1);
  });

  test('stops its workers when the visitor leaves the tool', async ({ page }) => {
    await openLab(page);
    await chooseFiles(page, FILES.slice(0, 3));
    await expect(status(page)).toHaveText('done · 3 of 3 · workers: 2');
    expect(page.workers()).toHaveLength(2);

    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Tools' })
      .click();
    await expect(page.getByRole('heading', { level: 1, name: 'Tools' })).toBeFocused();
    await expect.poll(() => page.workers().length).toBe(0);
  });
});
