import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import { sampleFile, type Sample } from '../support/files.ts';
import type { NetworkRecorder, Rule } from '../support/network.ts';

// SPEC 14: "no tool sends file content". Every test of the suite already fails when the page
// sends anything but `GET`s of its own assets (see `support/fixtures.ts`); the tests here run a
// tool on files, look for the bytes of those files in every request, and prove the check can fail.

async function waitUntilQuiet(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
}

test.describe('a tool run sends no file content', () => {
  const files: readonly Sample[] = [
    sampleFile('one.bin', 3_000, 0x11111111),
    sampleFile('two.bin', 90_000, 0x22222222),
    sampleFile('three.bin', 20, 0x33333333),
  ];

  test('hashing files in workers only loads the tool and the worker script', async ({
    page,
    net,
  }) => {
    for (const file of files) {
      net.watch(file.buffer);
    }
    await page.goto('/tools/worker-lab');
    await expect(page.getByRole('heading', { level: 1, name: 'Worker lab' })).toBeVisible();
    const before = net.requests.length;

    await page.locator('input[type="file"]').setInputFiles([...files]);
    await expect(page.getByTestId('lab-status')).toHaveAttribute('data-status', 'done');
    await page.getByRole('button', { name: 'Download report' }).click();
    await waitUntilQuiet(page);

    // The recorder sees the worker script load (requests of workers are recorded too) ...
    expect(net.requests.map((request) => new URL(request.url).pathname)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^\/assets\/worker-[\w-]+\.js$/)]),
    );
    // ... and during the run itself nothing but that left the page.
    const duringRun = net.requests.slice(before);
    for (const request of duringRun) {
      expect(request.method).toBe('GET');
      expect(new URL(request.url).pathname).toMatch(/^\/assets\//);
    }
    expect(net.violations()).toEqual([]);
  });

  test('every tool page opens without a request beyond the page and its own assets', async ({
    page,
    net,
  }) => {
    await page.goto('/tools');
    const hrefs = await page
      .getByRole('main')
      .getByRole('link')
      .evaluateAll((links) =>
        links
          .map((link) => link.getAttribute('href') ?? '')
          .filter((href) => href.startsWith('/tools/')),
      );
    expect(hrefs.length).toBeGreaterThanOrEqual(3);
    for (const href of hrefs) {
      await page.goto(href);
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    }
    await waitUntilQuiet(page);
    expect(net.violations()).toEqual([]);
  });
});

test.describe('the check can fail', () => {
  // `leaky-tool` breaks the promise four ways. These tests turn the privacy rules off for the
  // run and assert that they would have fired: a check that cannot fail proves nothing.
  test.use({ enforcePrivacy: false });

  const leaks: readonly {
    readonly button: string;
    readonly done: string;
    readonly rules: readonly Rule[];
  }[] = [
    { button: 'Leak by POST', done: 'sent post', rules: ['method', 'body', 'path', 'content'] },
    { button: 'Leak in a URL', done: 'sent query', rules: ['query', 'content'] },
    { button: 'Leak by beacon', done: 'sent beacon', rules: ['method', 'body', 'path', 'content'] },
    { button: 'Leak from a worker', done: 'sent worker', rules: ['origin', 'content'] },
  ];

  async function blockLeaks(context: BrowserContext, origin: string): Promise<void> {
    // Nothing really leaves the machine: own assets pass, everything else is cut off.
    await context.route(
      (url) =>
        url.origin !== origin || url.pathname === '/__leak' || url.pathname === '/assets/leak.js',
      (route) => route.abort(),
    );
  }

  async function runLeak(
    page: Page,
    net: NetworkRecorder,
    leak: (typeof leaks)[number],
  ): Promise<void> {
    const file = sampleFile('secret.bin', 3_000, 0x44444444);
    net.watch(file.buffer);
    await page.goto('/tools/leaky-tool');
    await page.locator('input[type="file"]').setInputFiles(file);
    await expect(page.getByTestId('leak-status')).toHaveText('ready');
    await page.getByRole('button', { name: leak.button }).click();
    await expect(page.getByTestId('leak-status')).toHaveText(leak.done);
  }

  for (const leak of leaks) {
    test(`${leak.button.toLowerCase()} is caught`, async ({ page, context, baseURL, net }) => {
      await blockLeaks(context, new URL(baseURL ?? '').origin);
      await runLeak(page, net, leak);

      await expect
        .poll(() => new Set(net.violations().map((violation) => violation.rule)).has('content'))
        .toBe(true);
      const rules = new Set(net.violations().map((violation) => violation.rule));
      for (const rule of leak.rules) {
        expect(rules, `rule ${rule}`).toContain(rule);
      }
      // The same call the suite makes at the end of every test would fail it here.
      expect(() => {
        net.assertClean();
      }).toThrow(/the page sent something it must not/);
      expect(() => {
        net.assertClean();
      }).toThrow(/file content found/);
    });
  }

  test('a clean run on the same tool is not flagged', async ({ page, context, baseURL, net }) => {
    await blockLeaks(context, new URL(baseURL ?? '').origin);
    const file = sampleFile('secret.bin', 3_000, 0x44444444);
    net.watch(file.buffer);
    await page.goto('/tools/leaky-tool');
    await page.locator('input[type="file"]').setInputFiles(file);
    await expect(page.getByTestId('leak-status')).toHaveText('ready');
    await waitUntilQuiet(page);
    net.assertClean();
  });
});
