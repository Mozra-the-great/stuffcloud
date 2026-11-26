import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import { expectKeyboardOnly } from '../support/keyboard.ts';
import { expectNoHorizontalScroll } from '../support/reflow.ts';

// SQL formatter in the built app, in Chromium and Firefox (T-23, #28). The accessibility gate
// (T-05, #13) applies to every tool: `a11y.check` after each state, a keyboard route for each
// action, results in live regions.

async function open(page: Page): Promise<void> {
  await page.goto('/tools/sql-formatter');
  await expect(
    page.getByRole('heading', { level: 1, name: /^(SQL formatter|SQL-Formatierer)$/ }),
  ).toBeVisible();
}

function input(page: Page): ReturnType<Page['getByRole']> {
  return page.getByRole('textbox', { name: 'SQL', exact: true });
}

function result(page: Page): ReturnType<Page['getByRole']> {
  return page.getByRole('textbox', { name: 'Formatted SQL', exact: true });
}

/** The tool's own polite status line (the first one on the page is the search count). */
function status(page: Page): ReturnType<Page['locator']> {
  return page.locator('main [data-tool-status][role="status"]');
}

test.describe('sql-formatter', () => {
  test('opens with one heading, formats the example and passes the accessibility gate', async ({
    page,
    a11y,
  }) => {
    await open(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(result(page)).toHaveValue(
      /^SELECT\n {2}u\.id,\n {2}u\.name,\n {2}count\(o\.id\) AS orders\nFROM\n {2}users u\nLEFT JOIN orders o ON/,
    );
    await expect(status(page)).toHaveText(/^Formatted: \d+ lines\.$/);
    await a11y.check(page, 'sql-formatter');
  });

  test('can be used with the keyboard alone', async ({ page }) => {
    await open(page);
    await expect(result(page)).toBeVisible();
    await expectKeyboardOnly(page, 'sql-formatter');
  });

  test('formats what is typed, in the case and layout chosen', async ({ page, a11y }) => {
    await open(page);
    await input(page).fill('Select a, b From t Where x = 1 And y = 2');
    await expect(result(page)).toHaveValue(
      'SELECT\n  a,\n  b\nFROM\n  t\nWHERE\n  x = 1\n  AND y = 2',
    );
    await page.getByRole('combobox', { name: 'Keywords' }).selectOption('lower');
    await expect(result(page)).toHaveValue(
      'select\n  a,\n  b\nfrom\n  t\nwhere\n  x = 1\n  and y = 2',
    );
    await page.getByRole('combobox', { name: 'Layout' }).selectOption('min');
    await expect(result(page)).toHaveValue('select a, b from t where x = 1 and y = 2');
    await a11y.check(page, 'sql-formatter: options');
  });

  test('reads the dialect chosen', async ({ page, a11y }) => {
    await open(page);
    await input(page).fill('select `a b`, "x" from t');
    await page.getByRole('combobox', { name: 'Dialect' }).selectOption('mysql');
    await expect(result(page)).toHaveValue('SELECT\n  `a b`,\n  "x"\nFROM\n  t');
    await a11y.check(page, 'sql-formatter: MySQL');
  });

  test('says there is nothing to format yet, and uses the result as the input', async ({
    page,
    a11y,
  }) => {
    await open(page);
    await input(page).fill('');
    await expect(status(page)).toHaveText('Nothing to format yet.');
    await a11y.check(page, 'sql-formatter: empty');
    await input(page).fill('select a from t');
    await page.getByRole('button', { name: 'Use the result as the input' }).click();
    await expect(input(page)).toHaveValue('SELECT\n  a\nFROM\n  t');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download result' }).click();
    expect((await download).suggestedFilename()).toBe('formatted.sql');
  });

  test('fits in 320 pixels without a horizontal scroll bar', async ({ page, a11y }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await open(page);
    await expect(result(page)).toBeVisible();
    await expectNoHorizontalScroll(page);
    await a11y.check(page, 'sql-formatter: phone');
  });
});

test.describe('sql-formatter in German', () => {
  test.use({ locale: 'de-DE' });

  test('shows the German texts and passes the gate', async ({ page, a11y }) => {
    await open(page);
    await expect(page.getByRole('heading', { level: 1, name: 'SQL-Formatierer' })).toBeVisible();
    await expect(status(page)).toHaveText(/^Formatiert: \d+ Zeilen\.$/);
    await a11y.check(page, 'sql-formatter: German');
  });
});
