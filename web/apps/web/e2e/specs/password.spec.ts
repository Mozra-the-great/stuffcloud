import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import { expectKeyboardOnly } from '../support/keyboard.ts';
import { expectNoHorizontalScroll } from '../support/reflow.ts';

// Password generator in the built app, in Chromium and Firefox (T-22, #27). The accessibility gate
// (T-05, #13) applies to every tool: `a11y.check` after each state, a keyboard route for each
// action, results in live regions.

async function open(page: Page): Promise<void> {
  await page.goto('/tools/password');
  await expect(
    page.getByRole('heading', { level: 1, name: /^(Password generator|Passwortgenerator)$/ }),
  ).toBeVisible();
}

function password(page: Page): ReturnType<Page['locator']> {
  return page.locator('.password');
}

/** The tool's own polite status line (the first one on the page is the search count). */
function status(page: Page): ReturnType<Page['locator']> {
  return page.locator('main [data-tool-status]');
}

test.describe('password', () => {
  test('opens with one heading and passes the accessibility gate', async ({ page, a11y }) => {
    await open(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(password(page)).toHaveText(/^.{20}$/);
    await expect(page.locator('.meter')).toHaveText(
      /^Entropy: \d+(\.\d)? bits · very strong · 90 possible characters$/,
    );
    await a11y.check(page, 'password');
  });

  test('can be used with the keyboard alone', async ({ page }) => {
    await open(page);
    await expectKeyboardOnly(page, 'password');
  });

  test('makes a new password with the keyboard and announces it without the password', async ({
    page,
    a11y,
  }) => {
    await open(page);
    const first = await password(page).textContent();
    await page.getByRole('button', { name: 'Generate a new password' }).focus();
    await page.keyboard.press('Enter');
    await expect(password(page)).not.toHaveText(first ?? '');
    await expect(status(page)).toHaveText(
      /^New password ready\. Entropy \d+(\.\d)? bits, very strong\.$/,
    );
    await a11y.check(page, 'password: new');
  });

  test('follows the length and the kinds of characters', async ({ page, a11y }) => {
    await open(page);
    const length = page.getByRole('spinbutton', { name: 'Length' });
    await length.fill('12');
    await expect(password(page)).toHaveText(/^.{12}$/);
    for (const name of ['Uppercase letters (A to Z)', 'Symbols (!#$%&…)']) {
      await page.getByRole('checkbox', { name }).uncheck();
    }
    await expect(password(page)).toHaveText(/^[a-z0-9]{12}$/);
    await expect(page.locator('.meter')).toContainText('36 possible characters');
    await a11y.check(page, 'password: lower case and digits');
    await page.getByRole('checkbox', { name: /Leave out look-alike/ }).check();
    await expect(password(page)).not.toHaveText(/[l1o0]/);
    await a11y.check(page, 'password: without look-alikes');
  });

  test('says what is wrong with the length or the kinds, and shows no password', async ({
    page,
    a11y,
  }) => {
    await open(page);
    await page.getByRole('spinbutton', { name: 'Length' }).fill('500');
    await expect(page.getByText('Enter a whole number from 4 to 128.')).toBeVisible();
    await expect(password(page)).toHaveCount(0);
    await a11y.check(page, 'password: bad length');
    await page.getByRole('spinbutton', { name: 'Length' }).fill('16');
    for (const name of [
      'Lowercase letters (a to z)',
      'Uppercase letters (A to Z)',
      'Digits (0 to 9)',
      'Symbols (!#$%&…)',
    ]) {
      await page.getByRole('checkbox', { name }).uncheck();
    }
    await expect(page.getByText('Choose at least one kind of character.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Generate a new password' })).toBeDisabled();
    await a11y.check(page, 'password: no kinds');
  });

  test('copies the password with the keyboard and confirms it', async ({
    page,
    context,
    browserName,
    a11y,
  }) => {
    if (browserName === 'chromium') {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    }
    await open(page);
    const shown = await password(page).textContent();
    await page.getByRole('button', { name: 'Copy password' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('region', { name: 'Notifications' })).toContainText(
      'Copied the password',
    );
    if (browserName === 'chromium') {
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(shown);
    }
    await a11y.check(page, 'password: copied');
  });

  test('draws from the secure generator: a hundred passwords are all different', async ({
    page,
  }) => {
    await open(page);
    const seen = new Set<string>();
    const button = page.getByRole('button', { name: 'Generate a new password' });
    for (let index = 0; index < 100; index += 1) {
      await button.click();
      seen.add((await password(page).textContent()) ?? '');
    }
    expect(seen.size).toBe(100);
  });

  test('fits in 320 pixels without a horizontal scroll bar', async ({ page, a11y }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await open(page);
    await page.getByRole('spinbutton', { name: 'Length' }).fill('128');
    await expect(password(page)).toHaveText(/^.{128}$/);
    await expectNoHorizontalScroll(page);
    await a11y.check(page, 'password: phone');
  });
});

test.describe('password in German', () => {
  test.use({ locale: 'de-DE' });

  test('shows the German texts and passes the gate', async ({ page, a11y }) => {
    await open(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Passwortgenerator' })).toBeVisible();
    await expect(page.locator('.meter')).toContainText('sehr stark');
    await page.getByRole('spinbutton', { name: 'Länge' }).fill('1');
    await expect(page.getByText('Gib eine ganze Zahl von 4 bis 128 ein.')).toBeVisible();
    await a11y.check(page, 'password: German');
  });
});
