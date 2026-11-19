import type { Page } from '@playwright/test';
import { attachScreenshot, expect, test } from '../support/fixtures.ts';

// The sample tool of the registry tests (`tests/fixtures/sample-tool`) in the built app: one
// manifest, and the tool is in navigation, search and routing (issue #12, ADR 0012).

test.describe('the sample tool in the registry', () => {
  test('is listed on the tools page with its category and a sticker', async ({
    page,
    a11y,
  }, testInfo) => {
    await page.goto('/tools');
    const tile = page.getByRole('link', { name: /Sample tool/ });
    await expect(tile).toHaveAttribute('href', '/tools/sample-tool');
    await expect(tile).toContainText('Text');
    // The sticker is decorative (empty alt) and really loaded: a broken image has no width.
    const sticker = tile.locator('img');
    await expect(sticker).toHaveAttribute('alt', '');
    await expect
      .poll(() => sticker.evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBeGreaterThan(0);
    await a11y.check(page, 'tools page with tools');
    await attachScreenshot(page, testInfo, 'tools-with-tools.png');
  });

  test('is filtered by its category tab', async ({ page }) => {
    await page.goto('/tools');
    const categories = page.getByRole('navigation', { name: 'Categories' });
    await categories.getByRole('link', { name: 'Extras' }).click();
    await expect(page).toHaveURL('/tools?category=extra');
    await expect(page.getByRole('link', { name: /Sample tool/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Worker lab/ })).toBeVisible();

    await categories.getByRole('link', { name: 'Text' }).click();
    await expect(page.getByRole('link', { name: /Sample tool/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /Worker lab/ })).toHaveCount(0);
  });

  test('opens from the list: focus on the one h1, title, announcement, privacy note', async ({
    page,
    a11y,
  }, testInfo) => {
    await page.goto('/tools');
    await page.getByRole('link', { name: /Sample tool/ }).click();

    const heading = page.getByRole('heading', { level: 1, name: 'Sample tool' });
    await expect(heading).toBeFocused();
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page).toHaveURL('/tools/sample-tool');
    await expect(page).toHaveTitle('Sample tool · stuffcloud');
    await expect(
      page.locator('[role="status"][aria-live="polite"]', { hasText: 'Navigated to Sample tool' }),
    ).toBeAttached();
    const main = page.locator('main');
    await expect(main).toContainText('Does nothing, to show how a tool is wired.');
    await expect(main).toContainText('Your files stay in this browser. Nothing is uploaded.');
    await expect(page.getByTestId('sample-body')).toHaveText('Sample tool body');
    await a11y.check(page, 'sample tool');
    await attachScreenshot(page, testInfo, 'sample-tool.png');
  });

  test('opens as a deep link, in the language of the browser or the choice', async ({ page }) => {
    await page.goto('/tools/sample-tool');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sample tool');
    await page.getByRole('button', { name: 'Deutsch' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Beispiel-Tool');
    await expect(page.locator('main')).toContainText(
      'Tut nichts, zeigt nur die Verdrahtung eines Tools.',
    );
    await expect(page.locator('main')).toContainText(
      'Deine Dateien bleiben in diesem Browser. Es wird nichts hochgeladen.',
    );
    await expect(page).toHaveTitle('Beispiel-Tool · stuffcloud');
  });
});

test.describe('the sample tool in search', () => {
  async function search(page: Page, query: string): Promise<void> {
    await page.goto('/');
    // The shell treats a navigation that starts before the first page has rendered as part of the
    // first load and leaves focus alone, so let the home page render first.
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.keyboard.press('Control+K');
    await page.getByRole('searchbox', { name: 'Search' }).fill(query);
  }

  for (const [how, query] of [
    ['its name', 'sample'],
    ['its id', 'sample-tool'],
    ['a keyword', 'demo'],
    ['a keyword of the other language', 'beispiel'],
    ['the name of the other language', 'Beispiel-Tool'],
  ] as const) {
    test(`is found by ${how}`, async ({ page }) => {
      await search(page, query);
      const results = page.getByRole('list', { name: 'Search results' });
      await expect(results.getByRole('link', { name: /Sample tool/ })).toBeVisible();
    });
  }

  test('is not found by a word that only appears in its description', async ({ page }) => {
    await search(page, 'wired');
    await expect(page.getByRole('dialog').getByRole('status')).toHaveText('No tools found');
  });

  test('is opened with Enter, and focus lands on its heading', async ({ page }) => {
    await search(page, 'demo');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1, name: 'Sample tool' })).toBeFocused();
    await expect(page).toHaveURL('/tools/sample-tool');
  });

  test('is opened by clicking a result', async ({ page }) => {
    await search(page, 'sample');
    await page.getByRole('list', { name: 'Search results' }).getByRole('link').first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'Sample tool' })).toBeFocused();
  });
});

test.describe('capabilities', () => {
  test('a browser without Web Workers gets a notice instead of a tool that needs them', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'Worker', { value: undefined, configurable: true });
    });
    await page.goto('/tools/worker-lab');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Worker lab');
    await expect(page.locator('main')).toContainText(
      'This browser cannot run this tool. Missing: Web Workers.',
    );
    await expect(page.getByRole('button', { name: 'Choose files' })).toHaveCount(0);
  });
});
