import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import { expectKeyboardOnly } from '../support/keyboard.ts';

// CRON expression in the built app, in Chromium and Firefox (T-19, #24). The accessibility gate
// (T-05, #13) applies to every tool: `a11y.check` after each state, a keyboard route for each
// action, results in live regions. The clock is fixed: Monday 2026-06-01, 10:00 UTC.

const NOW = new Date('2026-06-01T10:00:00Z');

async function open(page: Page): Promise<void> {
  await page.clock.setFixedTime(NOW);
  await page.goto('/tools/cron');
  await expect(
    page.getByRole('heading', { level: 1, name: /^(CRON expression|CRON-Ausdruck)$/ }),
  ).toBeVisible();
  await page.getByRole('combobox', { name: /^(Time zone|Zeitzone)$/ }).selectOption('UTC');
}

function expression(page: Page): ReturnType<Page['getByRole']> {
  return page.getByRole('textbox', { name: /^(CRON expression|CRON-Ausdruck)$/ });
}

/** The tool's own polite status line (the first one on the page is the search count). */
function status(page: Page): ReturnType<Page['locator']> {
  return page.locator('main .tool-status');
}

function explanation(page: Page): ReturnType<Page['locator']> {
  return page.locator('.explanation');
}

function utcColumn(page: Page): ReturnType<Page['locator']> {
  return page.locator('tbody tr td:nth-child(3)');
}

test.describe('cron', () => {
  test('opens with one heading and passes the accessibility gate', async ({ page, a11y }) => {
    await open(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1, name: 'CRON expression' })).toBeVisible();
    await expect(explanation(page)).toHaveText(
      'Every 15 minutes from 09:00 through 17:59, from Monday through Friday',
    );
    await expect(utcColumn(page)).toHaveCount(10);
    await expect(utcColumn(page).first()).toHaveText('2026-06-01 10:15:00');
    await a11y.check(page, 'cron');
  });

  test('can be used with the keyboard alone', async ({ page }) => {
    await open(page);
    await expectKeyboardOnly(page, 'cron');
  });

  test('explains a typed expression, lists its runs and announces both when the field is committed', async ({
    page,
    a11y,
  }) => {
    await open(page);
    const field = expression(page);
    await field.fill('0 9 * * 1-5');
    await expect(explanation(page)).toHaveText('At 09:00, from Monday through Friday');
    await expect(utcColumn(page).first()).toHaveText('2026-06-02 09:00:00');
    await expect(utcColumn(page).nth(4)).toHaveText('2026-06-08 09:00:00');
    await a11y.check(page, 'cron: explained');
    await field.press('Enter');
    await expect(status(page)).toContainText('At 09:00, from Monday through Friday. Next run:');
    await a11y.check(page, 'cron: announced');
  });

  test('says what is wrong with an expression, in the field and in the live region', async ({
    page,
    a11y,
  }) => {
    await open(page);
    const field = expression(page);
    await field.fill('61 25 * * *');
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText('Minute: "61" is outside 0 to 59.')).toBeVisible();
    await expect(page.getByText('Hour: "25" is outside 0 to 23.')).toBeVisible();
    await expect(page.locator('.explanation')).toHaveCount(0);
    await expect(page.getByRole('table')).toHaveCount(0);
    await a11y.check(page, 'cron: invalid');
    await field.press('Enter');
    await expect(status(page)).toContainText('Minute: "61" is outside 0 to 59.');
  });

  test('chooses the time zone and the number of runs with the keyboard', async ({ page, a11y }) => {
    await open(page);
    await expression(page).fill('0 9 * * *');
    const zone = page.getByRole('combobox', { name: 'Time zone' });
    await zone.focus();
    await page.keyboard.press('Tab');
    const count = page.getByRole('spinbutton', { name: 'Number of runs' });
    await expect(count).toBeFocused();
    await count.fill('3');
    await expect(utcColumn(page)).toHaveCount(3);

    await zone.selectOption('Asia/Kolkata');
    await expect(utcColumn(page).first()).toHaveText('2026-06-02 03:30:00');
    await expect(page.getByRole('columnheader', { name: 'Time in Asia/Kolkata' })).toBeVisible();
    await expect(status(page)).toContainText('At 09:00 every day. Next run:');
    await a11y.check(page, 'cron: other zone');

    await count.fill('0');
    await expect(page.getByText('Enter a whole number from 1 to 50.')).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
    await a11y.check(page, 'cron: bad count');
  });

  test('skips the hour that does not exist when the clock goes forward', async ({ page }) => {
    await open(page);
    await page.clock.setFixedTime(new Date('2026-03-27T12:00:00Z'));
    await page.reload();
    await page.getByRole('combobox', { name: 'Time zone' }).selectOption('Europe/Berlin');
    await expression(page).fill('30 2 * * *');
    await page.getByRole('spinbutton', { name: 'Number of runs' }).fill('3');
    await expect(utcColumn(page)).toHaveText([
      '2026-03-28 01:30:00',
      '2026-03-30 00:30:00',
      '2026-03-31 00:30:00',
    ]);
  });

  test('explains the notes: macros, both day fields, and a schedule that ends', async ({
    page,
    a11y,
  }) => {
    await open(page);
    await expression(page).fill('@weekly');
    await expect(explanation(page)).toHaveText('At 00:00, on Sunday');
    await expect(page.getByText('Written out: 0 0 * * 0')).toBeVisible();
    await expression(page).fill('0 0 13 * 5');
    await expect(page.getByText(/runs on every day that matches either of them/)).toBeVisible();
    await expression(page).fill('0 0 0 1 1 ? 2027,2028');
    await expect(
      page.getByText('Only 2 runs are left; the schedule ends after them.'),
    ).toBeVisible();
    await a11y.check(page, 'cron: notes');
    await expression(page).fill('0 0 30 2 *');
    await expect(page.getByText('This schedule never runs again.')).toBeVisible();
    await a11y.check(page, 'cron: never');
  });

  test('copies the explanation with the keyboard and confirms it', async ({
    page,
    context,
    browserName,
    a11y,
  }) => {
    if (browserName === 'chromium') {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    }
    await open(page);
    await expression(page).fill('0 9 * * *');
    await page.getByRole('button', { name: 'Copy explanation' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('region', { name: 'Notifications' })).toContainText(
      'Copied At 09:00 every day',
    );
    if (browserName === 'chromium') {
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('At 09:00 every day');
    }
    await a11y.check(page, 'cron: copied');
  });

  test('fits in 320 pixels without a horizontal scroll bar', async ({ page, a11y }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await open(page);
    await expression(page).fill('*/5 * * * * *');
    await expect(page.getByRole('table')).toBeVisible();
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
    await a11y.check(page, 'cron: phone');
  });
});

test.describe('cron in German', () => {
  test.use({ locale: 'de-DE' });

  test('shows the German texts and dates, and passes the gate', async ({ page, a11y }) => {
    await open(page);
    await expect(page.getByRole('heading', { level: 1, name: 'CRON-Ausdruck' })).toBeVisible();
    await expression(page).fill('0 9 * * 1-5');
    await expect(explanation(page)).toHaveText('Um 09:00 Uhr, von Montag bis Freitag');
    await expect(page.getByRole('columnheader', { name: 'Zeit in UTC' })).toBeVisible();
    await expression(page).fill('61 * * * *');
    await expect(page.getByText('Minute: „61“ liegt außerhalb von 0 bis 59.')).toBeVisible();
    await a11y.check(page, 'cron: German');
  });
});
