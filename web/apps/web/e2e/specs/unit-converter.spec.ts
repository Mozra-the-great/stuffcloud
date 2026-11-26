import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import { expectKeyboardOnly } from '../support/keyboard.ts';

// Unit converter in the built app, in Chromium and Firefox (T-18, #23). The accessibility gate
// (T-05, #13) applies to every tool: `a11y.check` after each state, a keyboard route for each
// action, results in live regions.

async function open(page: Page): Promise<void> {
  await page.goto('/tools/unit-converter');
  await expect(
    page.getByRole('heading', { level: 1, name: /^(Unit converter|Einheitenumrechner)$/ }),
  ).toBeVisible();
}

/** The big result: number and symbol. */
function result(page: Page): ReturnType<Page['locator']> {
  return page.locator('.equation');
}

/** The polite status line that announces what was converted (the first one on the page is the search count). */
function status(page: Page): ReturnType<Page['locator']> {
  return page.locator('[data-tool-status][role="status"]').nth(1);
}

test.describe('unit-converter', () => {
  test('opens with one heading and passes the accessibility gate', async ({ page, a11y }) => {
    await open(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1, name: 'Unit converter' })).toBeVisible();
    await expect(result(page)).toHaveText(/0\.621371\s+mi/);
    await a11y.check(page, 'unit-converter');
  });

  test('can be used with the keyboard alone', async ({ page }) => {
    await open(page);
    await expectKeyboardOnly(page, 'unit-converter');
  });

  test('converts a typed value, announces it and passes the gate', async ({ page, a11y }) => {
    await open(page);
    const value = page.getByRole('textbox', { name: 'Value' });
    await value.fill('100');
    await expect(result(page)).toHaveText(/62\.1371\s+mi/);
    await expect(page.getByRole('row', { name: /^Foot/ })).toContainText('328084');
    await a11y.check(page, 'unit-converter: converted');
    await value.press('Enter');
    await expect(status(page)).toHaveText('100 Kilometre = 62.1371 Mile');
    await a11y.check(page, 'unit-converter: announced');
  });

  test('chooses the units with the keyboard, and swaps them', async ({ page }) => {
    await open(page);
    const category = page.getByRole('combobox', { name: 'Category' });
    await category.focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(category).toHaveValue('temperature');
    // The units of the category are the defaults: Celsius to Fahrenheit.
    await expect(page.getByRole('combobox', { name: 'From' })).toHaveValue('c');
    await page.getByRole('textbox', { name: 'Value' }).fill('100');
    await expect(result(page)).toHaveText(/212\s+°F/);

    const swap = page.getByRole('button', { name: 'Swap units' });
    await swap.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('combobox', { name: 'From' })).toHaveValue('f');
    await expect(result(page)).toHaveText(/37\.7778\s+°C/);
    await expect(status(page)).toHaveText('100 Fahrenheit = 37.7778 Celsius');
  });

  test('keeps binary and decimal data units apart', async ({ page, a11y }) => {
    await open(page);
    await page.getByRole('combobox', { name: 'Category' }).selectOption('data');
    await expect(result(page)).toHaveText(/0\.931323\s+GiB/);
    await expect(page.getByText(/count in thousands/)).toBeVisible();
    await a11y.check(page, 'unit-converter: data');
  });

  test('follows the precision', async ({ page, a11y }) => {
    await open(page);
    const precision = page.getByRole('spinbutton', { name: 'Significant digits' });
    await precision.fill('3');
    await expect(result(page)).toHaveText(/0\.621\s+mi/);
    await precision.fill('15');
    await expect(result(page)).toHaveText(/0\.621371192237334\s+mi/);
    await a11y.check(page, 'unit-converter: precision');
  });

  test('says what is wrong with a value, and with a temperature below absolute zero', async ({
    page,
    a11y,
  }) => {
    await open(page);
    const value = page.getByRole('textbox', { name: 'Value' });
    await value.fill('abc');
    await expect(page.getByText(/This is not a number/)).toBeVisible();
    await expect(value).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('table')).toHaveCount(0);
    await a11y.check(page, 'unit-converter: not a number');
    await value.press('Enter');
    await expect(status(page)).toContainText('This is not a number');

    await page.getByRole('combobox', { name: 'Category' }).selectOption('temperature');
    await value.fill('-300');
    await expect(page.getByText('This is below absolute zero.')).toBeVisible();
    await a11y.check(page, 'unit-converter: below absolute zero');
    await value.fill('-273.15');
    await expect(result(page)).toHaveText(/-459\.67\s+°F/);
  });

  test('finds a unit and sets it as source or target, also across categories', async ({
    page,
    a11y,
  }) => {
    await open(page);
    const search = page.getByRole('searchbox', { name: 'Find a unit' });
    await search.fill('gallon');
    await expect(
      page.getByRole('list', { name: 'Matching units' }).getByRole('listitem'),
    ).toHaveCount(2);
    await expect(page.locator('[data-tool-status][role="status"]').first()).toHaveText(
      '2 units found',
    );
    await a11y.check(page, 'unit-converter: search results');

    const asTarget = page.getByRole('button', {
      name: 'Use Gallon (US) as the unit to convert to',
    });
    await asTarget.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('combobox', { name: 'Category' })).toHaveValue('volume');
    await expect(page.getByRole('combobox', { name: 'To' })).toHaveValue('gal');
    await expect(page.getByRole('combobox', { name: 'From' })).toHaveValue('l');

    await search.fill('zzzz');
    await expect(page.locator('[data-tool-status][role="status"]').first()).toHaveText(
      'No unit found',
    );
    await a11y.check(page, 'unit-converter: nothing found');
  });

  test('copies the result with the keyboard and confirms it', async ({
    page,
    context,
    browserName,
    a11y,
  }) => {
    if (browserName === 'chromium') {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    }
    await open(page);
    await page.getByRole('button', { name: 'Copy result' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('region', { name: 'Notifications' })).toContainText(
      'Copied 0.621371 mi',
    );
    if (browserName === 'chromium') {
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('0.621371');
    }
    await a11y.check(page, 'unit-converter: copied');
  });

  test('fits in 320 pixels without a horizontal scroll bar', async ({ page, a11y }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await open(page);
    await page.getByRole('searchbox', { name: 'Find a unit' }).fill('meter');
    await expect(page.getByRole('list', { name: 'Matching units' })).toBeVisible();
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
    await a11y.check(page, 'unit-converter: phone');
  });
});

test.describe('unit-converter in German', () => {
  test.use({ locale: 'de-DE' });

  test('shows the German texts, the decimal comma, and passes the gate', async ({ page, a11y }) => {
    await open(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Einheitenumrechner' })).toBeVisible();
    await expect(result(page)).toHaveText(/0,621371\s+mi/);
    await expect(page.getByRole('combobox', { name: 'Kategorie' })).toHaveValue('length');
    await a11y.check(page, 'unit-converter: German');
  });
});
