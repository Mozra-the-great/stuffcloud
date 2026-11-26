import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import { expectKeyboardOnly } from '../support/keyboard.ts';
import { expectNoHorizontalScroll } from '../support/reflow.ts';

// URL encoder and parser in the built app, in Chromium and Firefox (T-22, #27). The accessibility
// gate (T-05, #13) applies to every tool: `a11y.check` after each state, a keyboard route for each
// action, results in live regions.

async function open(page: Page): Promise<void> {
  await page.goto('/tools/url');
  await expect(
    page.getByRole('heading', {
      level: 1,
      name: /^(URL encoder and parser|URL-Kodierer und -Parser)$/,
    }),
  ).toBeVisible();
}

/** The tool's own polite status line (the first one on the page is the search count). */
function status(page: Page): ReturnType<Page['locator']> {
  return page.locator('main [data-tool-status][role="status"]');
}

function alert(page: Page): ReturnType<Page['locator']> {
  return page.locator('main [data-tool-status][role="alert"]');
}

test.describe('url', () => {
  test('opens with one heading and passes the accessibility gate', async ({ page, a11y }) => {
    await open(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByRole('table', { name: 'The parts of the URL' })).toBeVisible();
    await a11y.check(page, 'url');
  });

  test('can be used with the keyboard alone', async ({ page }) => {
    await open(page);
    await expectKeyboardOnly(page, 'url');
  });

  test('encodes and decodes with the keyboard, and announces both', async ({ page, a11y }) => {
    await open(page);
    const text = page.getByRole('textbox', { name: 'Text', exact: true });
    await text.fill('a b&c=ä');
    await page.getByRole('button', { name: 'Encode' }).focus();
    await page.keyboard.press('Enter');
    const result = page.getByRole('textbox', { name: 'Result' });
    await expect(result).toHaveValue('a%20b%26c%3D%C3%A4');
    await expect(status(page).first()).toHaveText('Encoded. The result is below.');
    await a11y.check(page, 'url: encoded');
    await text.fill('a+b%2Fc%20d');
    await page.getByRole('button', { name: 'Decode' }).focus();
    await page.keyboard.press('Enter');
    await expect(result).toHaveValue('a+b/c d');
    await page.getByRole('combobox', { name: 'Kind of encoding' }).selectOption('form');
    await page.getByRole('button', { name: 'Decode' }).click();
    await expect(result).toHaveValue('a b/c d');
    await a11y.check(page, 'url: decoded');
  });

  test('says where a percent sequence is broken', async ({ page, a11y }) => {
    await open(page);
    await page.getByRole('textbox', { name: 'Text', exact: true }).fill('ok%C3 x');
    await page.getByRole('button', { name: 'Decode' }).click();
    await expect(alert(page).first()).toContainText('the percent sequence at character 3');
    await expect(alert(page).first()).toHaveCSS('color', 'rgb(255, 79, 139)');
    await expect(page.getByRole('textbox', { name: 'Result' })).toHaveCount(0);
    await a11y.check(page, 'url: malformed');
  });

  test('copies the result and confirms it', async ({ page, context, browserName, a11y }) => {
    if (browserName === 'chromium') {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    }
    await open(page);
    await page.getByRole('textbox', { name: 'Text', exact: true }).fill('a b');
    await page.getByRole('button', { name: 'Encode' }).click();
    await page.getByRole('button', { name: 'Copy result' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('region', { name: 'Notifications' })).toContainText(
      'Copied the result',
    );
    if (browserName === 'chromium') {
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('a%20b');
    }
    await a11y.check(page, 'url: copied');
  });

  test('parses a URL into its parts and query parameters', async ({ page, a11y }) => {
    await open(page);
    const address = page.getByRole('textbox', { name: 'URL', exact: true });
    await address.fill('https://user@Example.com:8443/a%20b?x=1&y=two+words&x=3#top');
    const parts = page.getByRole('table', { name: 'The parts of the URL' });
    await expect(parts.getByRole('row', { name: /^Host example\.com/ })).toBeVisible();
    await expect(parts.getByRole('row', { name: /^Port 8443/ })).toBeVisible();
    await expect(parts.getByRole('row', { name: /^Fragment #top/ })).toBeVisible();
    const query = page.getByRole('table', { name: 'The query parameters in order, decoded' });
    await expect(query.getByRole('row')).toHaveCount(4);
    await expect(query.getByRole('row').nth(2)).toContainText('two words');
    await address.press('Tab');
    await expect(status(page).last()).toHaveText('Parsed: host example.com, 3 query parameters.');
    await a11y.check(page, 'url: parsed');
  });

  test('says that text is no URL', async ({ page, a11y }) => {
    await open(page);
    const address = page.getByRole('textbox', { name: 'URL', exact: true });
    await address.fill('example.com/path');
    await expect(address).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText(/This is not a complete URL/)).toBeVisible();
    await expect(page.getByRole('table', { name: 'The parts of the URL' })).toHaveCount(0);
    await a11y.check(page, 'url: not a URL');
  });

  test('fits in 320 pixels without a horizontal scroll bar', async ({ page, a11y }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await open(page);
    await expect(page.getByRole('table', { name: 'The parts of the URL' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await a11y.check(page, 'url: phone');
  });
});

test.describe('url in German', () => {
  test.use({ locale: 'de-DE' });

  test('shows the German texts and passes the gate', async ({ page, a11y }) => {
    await open(page);
    await expect(
      page.getByRole('heading', { level: 1, name: 'URL-Kodierer und -Parser' }),
    ).toBeVisible();
    await expect(page.getByRole('table', { name: 'Die Bestandteile der URL' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Text', exact: true }).fill('ä b');
    await page.getByRole('button', { name: 'Kodieren', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Ergebnis' })).toHaveValue('%C3%A4%20b');
    await a11y.check(page, 'url: German');
  });
});
