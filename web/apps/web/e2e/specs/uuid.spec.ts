import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import { expectKeyboardOnly } from '../support/keyboard.ts';
import { expectNoHorizontalScroll } from '../support/reflow.ts';

// UUID generator in the built app, in Chromium and Firefox (T-21, #26). The accessibility gate
// (T-05, #13) applies to every tool: `a11y.check` after each state, a keyboard route for each
// action, results in live regions.

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function open(page: Page): Promise<void> {
  await page.goto('/tools/uuid');
  await expect(
    page.getByRole('heading', { level: 1, name: /^(UUID generator|UUID-Generator)$/ }),
  ).toBeVisible();
  await expect(list(page)).not.toHaveValue('');
}

function list(page: Page): ReturnType<Page['getByRole']> {
  return page.getByRole('textbox', { name: /^(UUIDs, one per line|UUIDs, eine pro Zeile)$/ });
}

async function uuids(page: Page): Promise<string[]> {
  const value = await list(page).inputValue();
  return value === '' ? [] : value.split('\n');
}

/** The tool's own polite status line (the first one on the page is the search count). */
function status(page: Page): ReturnType<Page['locator']> {
  return page.locator('main [data-tool-status]');
}

test.describe('uuid', () => {
  test('opens with one heading, five version 4 UUIDs and passes the accessibility gate', async ({
    page,
    a11y,
  }) => {
    await open(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    const made = await uuids(page);
    expect(made).toHaveLength(5);
    for (const uuid of made) {
      expect(uuid).toMatch(V4);
    }
    await a11y.check(page, 'uuid');
  });

  test('can be used with the keyboard alone', async ({ page }) => {
    await open(page);
    await expectKeyboardOnly(page, 'uuid');
  });

  test('makes new UUIDs with the keyboard and announces how many', async ({ page, a11y }) => {
    await open(page);
    await expect(status(page)).toHaveText('');
    const first = await uuids(page);
    await page.getByRole('button', { name: 'Generate new UUIDs' }).focus();
    await page.keyboard.press('Enter');
    await expect(status(page)).toHaveText('Generated 5 version 4 UUIDs.');
    // A result line is green as designed (`tone="ok"`, kern#173), a failure pink.
    await expect(status(page)).toHaveCSS('color', 'rgb(61, 220, 132)');
    expect(await uuids(page)).not.toEqual(first);
    await a11y.check(page, 'uuid: new');
  });

  test('makes a thousand version 7 UUIDs that sort in the order they were made', async ({
    page,
    a11y,
  }) => {
    await open(page);
    await page.getByRole('combobox', { name: 'Version' }).selectOption('v7');
    await page.getByRole('spinbutton', { name: 'How many' }).fill('1000');
    await expect.poll(async () => (await uuids(page)).length).toBe(1000);
    const first = await uuids(page);
    await page.getByRole('button', { name: 'Generate new UUIDs' }).click();
    const second = await uuids(page);
    const all = [...first, ...second];
    expect(all).toHaveLength(2000);
    expect(all.every((uuid) => V7.test(uuid))).toBe(true);
    expect([...all].sort()).toEqual(all);
    expect(new Set(all).size).toBe(2000);
    await expect(status(page)).toHaveText('Generated 1,000 version 7 UUIDs, in order.');
    await a11y.check(page, 'uuid: version 7, bulk');
  });

  test('formats upper case and without hyphens', async ({ page, a11y }) => {
    await open(page);
    await page.getByRole('checkbox', { name: 'Uppercase letters' }).check();
    await page.getByRole('checkbox', { name: 'Hyphens' }).uncheck();
    for (const uuid of await uuids(page)) {
      expect(uuid).toMatch(/^[0-9A-F]{32}$/);
    }
    await a11y.check(page, 'uuid: upper case, no hyphens');
  });

  test('says what is wrong with the amount and shows no UUIDs', async ({ page, a11y }) => {
    await open(page);
    await page.getByRole('spinbutton', { name: 'How many' }).fill('1001');
    await expect(page.getByText('Enter a whole number from 1 to 1,000.').first()).toBeVisible();
    await expect(list(page)).toHaveValue('');
    await expect(page.getByRole('button', { name: 'Generate new UUIDs' })).toBeDisabled();
    await a11y.check(page, 'uuid: bad amount');
  });

  test('copies and downloads the UUIDs', async ({ page, context, browserName, a11y }) => {
    if (browserName === 'chromium') {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    }
    await open(page);
    const shown = await list(page).inputValue();
    await page.getByRole('button', { name: 'Copy all UUIDs' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('region', { name: 'Notifications' })).toContainText(
      'Copied the UUIDs',
    );
    if (browserName === 'chromium') {
      // The clipboard of Windows has CRLF line ends.
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      expect(copied.replaceAll('\r\n', '\n')).toBe(shown);
    }
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download as .txt' }).click();
    expect((await download).suggestedFilename()).toBe('uuid-v4.txt');
    await a11y.check(page, 'uuid: copied');
  });

  test('fits in 320 pixels without a horizontal scroll bar', async ({ page, a11y }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await open(page);
    await expectNoHorizontalScroll(page);
    await a11y.check(page, 'uuid: phone');
  });
});

test.describe('uuid in German', () => {
  test.use({ locale: 'de-DE' });

  test('shows the German texts and passes the gate', async ({ page, a11y }) => {
    await open(page);
    await page.getByRole('button', { name: 'Neue UUIDs erzeugen' }).click();
    await expect(status(page)).toHaveText('5 UUIDs der Version 4 erzeugt.');
    await page.getByRole('spinbutton', { name: 'Wie viele' }).fill('0');
    await expect(page.getByText('Gib eine ganze Zahl von 1 bis 1.000 ein.').first()).toBeVisible();
    await a11y.check(page, 'uuid: German');
  });
});
