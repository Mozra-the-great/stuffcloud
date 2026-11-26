import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import { expectKeyboardOnly } from '../support/keyboard.ts';
import { expectNoHorizontalScroll } from '../support/reflow.ts';

// Timestamp converter in the built app, in Chromium and Firefox (T-22, #27). The accessibility
// gate (T-05, #13) applies to every tool: `a11y.check` after each state, a keyboard route for each
// action, results in live regions. The clock is fixed: Monday 2026-06-01, 10:00 UTC.

const NOW = new Date('2026-06-01T10:00:00Z');

async function open(page: Page): Promise<void> {
  await page.clock.setFixedTime(NOW);
  await page.goto('/tools/timestamp');
  await expect(
    page.getByRole('heading', { level: 1, name: /^(Timestamp converter|Zeitstempel-Umrechner)$/ }),
  ).toBeVisible();
  await page.getByRole('combobox', { name: /^(Time zone|Zeitzone)$/ }).selectOption('UTC');
}

function input(page: Page): ReturnType<Page['getByRole']> {
  return page.getByRole('textbox', { name: /^(Timestamp or date|Zeitstempel oder Datum)$/ });
}

/** The tool's own polite status line (the first one on the page is the search count). */
function status(page: Page): ReturnType<Page['locator']> {
  return page.locator('main [data-tool-status]');
}

function value(page: Page, label: string): ReturnType<Page['locator']> {
  return page
    .getByRole('row', { name: new RegExp(`^${label}`) })
    .getByRole('cell')
    .first();
}

test.describe('timestamp', () => {
  test('opens with one heading and passes the accessibility gate', async ({ page, a11y }) => {
    await open(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(input(page)).toHaveValue('1780308000');
    await expect(value(page, 'ISO 8601, UTC')).toHaveText('2026-06-01T10:00:00.000Z');
    await expect(page.locator('.relative')).toHaveText('now');
    await a11y.check(page, 'timestamp');
  });

  test('can be used with the keyboard alone', async ({ page }) => {
    await open(page);
    await expectKeyboardOnly(page, 'timestamp');
  });

  test('turns epoch seconds and milliseconds into dates, and says which it read', async ({
    page,
    a11y,
  }) => {
    await open(page);
    await input(page).fill('1780394400');
    await expect(value(page, 'ISO 8601, UTC')).toHaveText('2026-06-02T10:00:00.000Z');
    await expect(page.locator('.relative')).toHaveText('tomorrow');
    await expect(page.getByText(/Read as seconds since 1970/)).toBeVisible();
    await a11y.check(page, 'timestamp: seconds');
    await input(page).fill('1780394400000');
    await expect(value(page, 'Epoch seconds')).toHaveText('1780394400');
    await expect(page.getByText(/Read as milliseconds since 1970/)).toBeVisible();
    await a11y.check(page, 'timestamp: milliseconds');
  });

  test('turns an ISO date into epoch numbers, and shows the clock of another zone', async ({
    page,
    a11y,
  }) => {
    await open(page);
    await input(page).fill('2026-06-01T12:00:00+02:00');
    await expect(value(page, 'Epoch seconds')).toHaveText('1780308000');
    await page.getByRole('combobox', { name: 'Time zone' }).selectOption('Asia/Kolkata');
    await expect(value(page, 'ISO 8601 in Asia/Kolkata')).toHaveText('2026-06-01T15:30:00+05:30');
    await expect(value(page, 'HTTP date')).toHaveText('Mon, 01 Jun 2026 10:00:00 GMT');
    await a11y.check(page, 'timestamp: other zone');
  });

  test('reads a time without offset in the chosen zone, and warns about a doubled hour', async ({
    page,
    a11y,
  }) => {
    await open(page);
    await page.getByRole('combobox', { name: 'Time zone' }).selectOption('Europe/Berlin');
    await input(page).fill('2026-10-25T02:30:00');
    await expect(value(page, 'ISO 8601, UTC')).toHaveText('2026-10-25T00:30:00.000Z');
    await expect(page.getByText(/happens twice in Europe\/Berlin/)).toBeVisible();
    await a11y.check(page, 'timestamp: ambiguous');
    await input(page).fill('2026-03-29T02:30:00');
    await expect(page.getByText(/does not exist in Europe\/Berlin/)).toBeVisible();
    await a11y.check(page, 'timestamp: gap');
  });

  test('says what is wrong with input, in the field and in the live region', async ({
    page,
    a11y,
  }) => {
    await open(page);
    await input(page).fill('soon');
    await expect(input(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText(/neither a number nor an ISO 8601 date/).first()).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
    await input(page).press('Tab');
    await expect(status(page)).toContainText('neither a number nor an ISO 8601 date');
    await a11y.check(page, 'timestamp: invalid');
  });

  test('puts in the current time, announces the moment, and copies a format', async ({
    page,
    context,
    browserName,
    a11y,
  }) => {
    if (browserName === 'chromium') {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    }
    await open(page);
    await input(page).fill('5');
    await page.getByRole('button', { name: 'Use the current time' }).focus();
    await page.keyboard.press('Enter');
    await expect(input(page)).toHaveValue('1780308000');
    await expect(status(page)).toHaveText('The input is now the current time.');
    await page.getByRole('button', { name: 'Copy ISO 8601 in UTC' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('region', { name: 'Notifications' })).toContainText(
      'Copied 2026-06-01T10:00:00.000Z',
    );
    if (browserName === 'chromium') {
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        '2026-06-01T10:00:00.000Z',
      );
    }
    await a11y.check(page, 'timestamp: copied');
  });

  test('fits in 320 pixels without a horizontal scroll bar', async ({ page, a11y }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await open(page);
    await expect(page.getByRole('table')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await a11y.check(page, 'timestamp: phone');
  });
});

test.describe('timestamp in German', () => {
  test.use({ locale: 'de-DE' });

  test('shows the German texts and dates, and passes the gate', async ({ page, a11y }) => {
    await open(page);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Zeitstempel-Umrechner' }),
    ).toBeVisible();
    await expect(page.locator('.relative')).toHaveText('jetzt');
    await expect(value(page, 'In Worten, UTC')).toContainText('Montag, 1. Juni 2026');
    await input(page).fill('Montag');
    await expect(page.getByText(/weder eine Zahl noch ein ISO-8601-Datum/).first()).toBeVisible();
    await a11y.check(page, 'timestamp: German');
  });
});
