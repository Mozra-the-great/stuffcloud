import type { Browser, Page } from '@playwright/test';
import { createAxeRunner } from '../support/axe.ts';
import { expect, test } from '../support/fixtures.ts';

// The accessibility gate of T-05 (#13): axe (WCAG 2.2 A/AA and best practice, zero violations) on
// every state the other specs do not already scan, in both browsers. The shell specs call
// `a11y.check` after their own states; this file covers the rest of the app and proves that the
// gate can fail.

const BROKEN_PAGE = `<!doctype html>
<html lang="en">
<head><title>broken</title></head>
<body>
  <main>
    <h1>Broken</h1>
    <img src="data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=" width="10" height="10">
    <button type="button"></button>
    <p style="color:#777;background:#888">Low contrast text</p>
    <a href="/somewhere"></a>
    <input type="text">
  </main>
</body>
</html>`;

/** What the gate throws for a page, or `undefined` when it passes. */
async function gateFailure(page: Page, label: string): Promise<string | undefined> {
  try {
    await createAxeRunner()(page, label);
    return undefined;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Runs `body` on a phone-sized page in its own context. */
async function onPhone(
  browser: Browser,
  baseURL: string | undefined,
  body: (page: Page) => Promise<void>,
): Promise<void> {
  const context = await browser.newContext({
    baseURL: baseURL ?? '',
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
    locale: 'en-US',
  });
  try {
    await body(await context.newPage());
  } finally {
    await context.close();
  }
}

test.describe('the gate can fail', () => {
  test('a page with real violations is rejected, and the report names every rule', async ({
    page,
  }) => {
    await page.setContent(BROKEN_PAGE);
    const report = await gateFailure(page, 'broken page');
    expect(report, 'the gate must reject this page').toBeDefined();
    expect(report).toContain('accessibility violation(s) in "broken page"');
    for (const rule of ['image-alt', 'button-name', 'color-contrast', 'link-name', 'label']) {
      expect(report, `rule ${rule} is reported`).toContain(`- ${rule} (`);
    }
    // The report says where and how to fix it.
    expect(report).toContain('https://dequeuniversity.com/rules/axe/');
    expect(report).toContain('<button type="button"></button>');
  });

  test('a best-practice violation fails the gate as well', async ({ page }) => {
    await page.setContent(
      '<!doctype html><html lang="en"><head><title>t</title></head><body><main><h1>One</h1><h3>Skipped a level</h3></main></body></html>',
    );
    expect(await gateFailure(page, 'skipped heading level')).toContain('- heading-order (');
  });

  test('a clean page passes', async ({ page, a11y }) => {
    await page.setContent(
      '<!doctype html><html lang="en"><head><title>fine</title></head><body><main><h1>Fine</h1><p>Text.</p></main></body></html>',
    );
    await a11y.check(page, 'clean page');
  });
});

test.describe('states of the shell', () => {
  test('the home and tools pages in German', async ({ page, a11y }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Deutsch' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Deine Sachen in deiner Cloud.',
    );
    await a11y.check(page, 'home (de)');

    await page.getByRole('link', { name: 'Tools' }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'Tools' })).toBeFocused();
    await a11y.check(page, 'tools (de)');
  });

  test('every category tab of the tools page', async ({ page, a11y }) => {
    await page.goto('/tools');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tools');
    const categories = page.getByRole('navigation', { name: 'Categories' });
    const names = await categories.getByRole('link').allInnerTexts();
    expect(names.length).toBeGreaterThan(1);
    for (const name of names) {
      const tab = categories.getByRole('link', { name, exact: true });
      await tab.click();
      await expect(tab).toHaveAttribute('aria-current', 'page');
      await a11y.check(page, `tools, category ${name}`);
    }
  });

  test('the search dialog with a hit and without', async ({ page, a11y }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.getByRole('button', { name: /^Search tools/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Search tools' });
    const box = dialog.getByRole('searchbox', { name: 'Search' });
    await box.fill('sample');
    await expect(dialog.getByRole('link', { name: /Sample tool/ })).toBeVisible();
    await a11y.check(page, 'search dialog with a hit');

    await box.fill('zzz-nothing-like-it');
    await expect(dialog.getByRole('status')).toHaveText('No tools found');
    await a11y.check(page, 'search dialog without a hit');
  });

  test('the phone layout of home, tools, 404 and the open menu', async ({
    browser,
    baseURL,
    a11y,
  }) => {
    await onPhone(browser, baseURL, async (page) => {
      for (const [path, heading] of [
        ['/', 'Your stuff, in your cloud.'],
        ['/tools', 'Tools'],
        ['/nowhere', 'Nothing here'],
      ] as const) {
        await page.goto(path);
        await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
        await a11y.check(page, `phone ${path}`);
      }
      await page.getByRole('button', { name: 'Open menu' }).click();
      await expect(page.getByRole('button', { name: 'Close menu' })).toBeVisible();
      await a11y.check(page, 'phone, menu open');
    });
  });

  test('the error page that replaces a page which fails to load', async ({ page, a11y }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // The chunk of the tools page cannot be fetched: the visitor gets the error page, with focus.
    await page.route('**/assets/Tools-*.js', (route) => route.abort());
    await page.getByRole('link', { name: 'Open the tools' }).click();
    const heading = page.getByRole('heading', { level: 1 });
    await expect(heading).toHaveText('Something went wrong');
    await expect(heading).toBeFocused();
    await a11y.check(page, 'error page');
  });
});

test.describe('reflow (WCAG 1.4.10)', () => {
  // 320 CSS pixels wide is a 1280 px window at 400 % zoom: the content must fit without a
  // horizontal scroll bar, which axe cannot see.
  for (const [path, heading] of [
    ['/', 'Your stuff, in your cloud.'],
    ['/tools', 'Tools'],
    ['/tools/worker-lab', 'Worker lab'],
    ['/tools/pdf-merge', 'Merge PDFs'],
    ['/tools/pdf-split', 'Split PDF'],
    ['/tools/pdf-pages', 'Rotate, delete, reorder PDF pages'],
    ['/nowhere', 'Nothing here'],
    ['/gallery.html', 'Components'],
  ] as const) {
    test(`${path} fits in 320 pixels`, async ({ browser, baseURL }) => {
      const context = await browser.newContext({
        baseURL: baseURL ?? '',
        viewport: { width: 320, height: 256 },
        reducedMotion: 'reduce',
        locale: 'en-US',
      });
      try {
        const page = await context.newPage();
        await page.goto(path);
        await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
        const overflow = await page.evaluate(() => {
          const root = document.documentElement;
          return {
            scrollWidth: root.scrollWidth,
            clientWidth: root.clientWidth,
            wide: [...document.body.querySelectorAll('*')]
              .filter((element) => element.getBoundingClientRect().right > root.clientWidth + 1)
              .slice(0, 5)
              .map((element) => element.outerHTML.slice(0, 100)),
          };
        });
        expect(
          overflow.scrollWidth,
          `content wider than the window: ${overflow.wide.join(' | ')}`,
        ).toBeLessThanOrEqual(overflow.clientWidth);
      } finally {
        await context.close();
      }
    });
  }
});

test.describe('the components', () => {
  test('the gallery shows every component and passes the gate', async ({ page, a11y }) => {
    await page.goto('/gallery.html');
    await expect(page.getByRole('heading', { level: 1, name: 'Components' })).toBeVisible();
    await a11y.check(page, 'component gallery');
  });

  test('the gallery on a phone', async ({ browser, baseURL, a11y }) => {
    await onPhone(browser, baseURL, async (page) => {
      await page.goto('/gallery.html');
      await expect(page.getByRole('heading', { level: 1, name: 'Components' })).toBeVisible();
      await a11y.check(page, 'component gallery, phone');
    });
  });

  test('the open dialog of the gallery', async ({ page, a11y }) => {
    await page.goto('/gallery.html');
    await page.getByRole('button', { name: 'Open dialog' }).click();
    await expect(page.getByRole('dialog', { name: 'Delete site' })).toBeVisible();
    await a11y.check(page, 'gallery dialog');
  });

  test('every kind of toast', async ({ page, a11y }) => {
    await page.goto('/gallery.html');
    for (const kind of ['info', 'success', 'warn', 'error']) {
      await page.getByRole('button', { name: kind, exact: true }).click();
      await expect(page.getByText(`A ${kind} message`)).toBeVisible();
    }
    await a11y.check(page, 'gallery with four toasts');
  });

  test('the tabs after a selection', async ({ page, a11y }) => {
    await page.goto('/gallery.html');
    await page.getByRole('tab', { name: 'YAML' }).click();
    await expect(page.getByRole('tab', { name: 'YAML' })).toHaveAttribute('aria-selected', 'true');
    await a11y.check(page, 'gallery, second tab selected');
  });
});

test.describe('the tools', () => {
  test('the worker lab: idle, while a job runs, cancelled', async ({ page, a11y }) => {
    await page.goto('/tools/worker-lab');
    await expect(page.getByRole('heading', { level: 1, name: 'Worker lab' })).toBeVisible();
    await a11y.check(page, 'worker lab, idle');

    await page.getByRole('button', { name: 'Start a job that never ends' }).click();
    await expect(page.getByTestId('lab-status')).toHaveAttribute('data-status', 'working');
    await a11y.check(page, 'worker lab, working');

    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('lab-status')).toHaveAttribute('data-status', 'cancelled');
    await a11y.check(page, 'worker lab, cancelled');
  });

  test('the notice that takes the place of a tool whose capability is missing', async ({
    page,
    a11y,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'Worker', { value: undefined, configurable: true });
    });
    await page.goto('/tools/worker-lab');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Worker lab');
    await expect(page.locator('main')).toContainText('This browser cannot run this tool.');
    await a11y.check(page, 'tool with a missing capability');
  });
});
