import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import { expectKeyboardOnly } from '../support/keyboard.ts';
import { expectNoHorizontalScroll } from '../support/reflow.ts';

// Regex tester in the built app, in Chromium and Firefox (T-22, #27). The accessibility gate
// (T-05, #13) applies to every tool: `a11y.check` after each state, a keyboard route for each
// action, results in live regions. The matching runs in a worker; the test that has a pattern run
// away proves it is stopped and that the page works afterwards.

async function open(page: Page): Promise<void> {
  await page.goto('/tools/regex');
  await expect(
    page.getByRole('heading', { level: 1, name: /^(Regex tester|Regex-Tester)$/ }),
  ).toBeVisible();
}

function pattern(page: Page): ReturnType<Page['getByRole']> {
  return page.getByRole('textbox', { name: /^(Pattern|Muster)$/ });
}

function testText(page: Page): ReturnType<Page['getByRole']> {
  return page.getByRole('textbox', { name: /^(Text to test|Zu prüfender Text)$/ });
}

/** The tool's own polite status line (the first one on the page is the search count). */
function status(page: Page): ReturnType<Page['locator']> {
  return page.locator('main .tool-status:not(.alert)');
}

function alert(page: Page): ReturnType<Page['locator']> {
  return page.locator('main .tool-status.alert');
}

function matchRows(page: Page): ReturnType<Page['locator']> {
  return page.locator('tbody tr');
}

test.describe('regex', () => {
  test('opens with one heading and passes the accessibility gate', async ({ page, a11y }) => {
    await open(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(matchRows(page)).toHaveCount(2);
    await expect(status(page)).toHaveText('2 matches found.');
    await expect(page.locator('mark')).toHaveText(['2026-06-01', '2026-06-15']);
    await a11y.check(page, 'regex');
  });

  test('can be used with the keyboard alone', async ({ page }) => {
    await open(page);
    await expect(matchRows(page)).toHaveCount(2);
    await expectKeyboardOnly(page, 'regex');
  });

  test('lists the matches with their position and groups', async ({ page, a11y }) => {
    await open(page);
    await expect(matchRows(page)).toHaveCount(2);
    const first = matchRows(page).first();
    await expect(first.getByRole('rowheader')).toHaveText('1');
    await expect(first.getByRole('cell').nth(0)).toHaveText('9');
    await expect(first.getByRole('cell').nth(1)).toHaveText('2026-06-01');
    await expect(first.getByRole('cell').nth(2)).toContainText('2026');
    await a11y.check(page, 'regex: matches');
  });

  test('explains the pattern part by part', async ({ page, a11y }) => {
    await open(page);
    await pattern(page).fill(String.raw`(?<year>\d{4})-\d\d`);
    await expect(page.locator('.explain li').first()).toContainText(
      'Group 1 named "year", remembered, containing:',
    );
    await expect(page.locator('.explain')).toContainText('A digit (0 to 9)');
    await expect(page.locator('.explain')).toContainText('The part before: exactly 4 times');
    await a11y.check(page, 'regex: explained');
  });

  test('sets flags with the keyboard', async ({ page, a11y }) => {
    await open(page);
    await pattern(page).fill('abc');
    await testText(page).fill('abc ABC');
    await expect(matchRows(page)).toHaveCount(1);
    const flag = page.getByRole('checkbox', { name: /^i: ignore upper and lower case/ });
    await flag.focus();
    await page.keyboard.press('Space');
    await expect(flag).toBeChecked();
    await expect(matchRows(page)).toHaveCount(2);
    await expect(status(page)).toHaveText('2 matches found.');
    await a11y.check(page, 'regex: flag');
  });

  test('says nothing matched, and shows an empty pattern as nothing', async ({ page, a11y }) => {
    await open(page);
    await pattern(page).fill('zzz');
    await expect(status(page)).toHaveText('No match.');
    await expect(matchRows(page)).toHaveCount(0);
    await a11y.check(page, 'regex: no match');
    await pattern(page).fill('');
    await expect(page.locator('.explain')).toHaveCount(0);
    await expect(status(page)).toHaveText('');
  });

  test('marks a pattern that is not valid, with the message of the browser', async ({
    page,
    a11y,
  }) => {
    await open(page);
    await pattern(page).fill('a(');
    await expect(pattern(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText(/This is not a valid pattern: /)).toBeVisible();
    await expect(matchRows(page)).toHaveCount(0);
    await a11y.check(page, 'regex: invalid');
  });

  test('stops a pattern that runs away, says why, and works again afterwards', async ({
    page,
    a11y,
  }) => {
    await open(page);
    await expect(matchRows(page)).toHaveCount(2);
    await pattern(page).fill('(a+)+$');
    await testText(page).fill(`${'a'.repeat(34)}b`);
    await expect(alert(page)).toContainText('Stopped after 2 seconds.', { timeout: 15_000 });
    await expect(matchRows(page)).toHaveCount(0);
    await a11y.check(page, 'regex: stopped');
    // The page itself never froze: it takes the next edit, with a fresh worker.
    await pattern(page).fill('a+');
    await testText(page).fill('caat');
    await expect(status(page)).toHaveText('1 match found.');
    await expect(alert(page)).toHaveText('');
    await expect(page.locator('mark')).toHaveText('aa');
    await a11y.check(page, 'regex: recovered');
  });

  test('fits in 320 pixels without a horizontal scroll bar', async ({ page, a11y }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await open(page);
    await expect(matchRows(page)).toHaveCount(2);
    await expectNoHorizontalScroll(page);
    await a11y.check(page, 'regex: phone');
  });
});

test.describe('regex in German', () => {
  test.use({ locale: 'de-DE' });

  test('shows the German texts and the German explanation, and passes the gate', async ({
    page,
    a11y,
  }) => {
    await open(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Regex-Tester' })).toBeVisible();
    await expect(status(page)).toHaveText('2 Treffer gefunden.');
    await expect(page.locator('.explain li').first()).toContainText('Gruppe 1, gemerkt, mit:');
    await a11y.check(page, 'regex: German');
  });
});
