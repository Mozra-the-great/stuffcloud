import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import { expectKeyboardOnly } from '../support/keyboard.ts';

// User-agent parser in the built app, in Chromium and Firefox (T-19, #24). The accessibility gate
// (T-05, #13) applies to every tool: `a11y.check` after each state, a keyboard route for each
// action, results in live regions.

const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1';
const CRAWLER = 'Mozilla/5.0 (compatible; Googlebot/2.1; +https://bot.example/info)';

async function open(page: Page): Promise<void> {
  await page.goto('/tools/user-agent');
  await expect(
    page.getByRole('heading', { level: 1, name: /^(User-agent parser|User-Agent-Parser)$/ }),
  ).toBeVisible();
}

function field(page: Page): ReturnType<Page['getByRole']> {
  return page.getByRole('textbox', { name: /^(User-agent string|User-Agent-String)$/ });
}

/** The tool's own polite status line (the first one on the page is the search count). */
function status(page: Page): ReturnType<Page['locator']> {
  return page.locator('main [data-tool-status]');
}

function row(page: Page, label: string): ReturnType<Page['getByRole']> {
  return page.getByRole('row', { name: new RegExp(`^${label}`) });
}

test.describe('user-agent', () => {
  test('opens with one heading and passes the accessibility gate', async ({ page, a11y }) => {
    await open(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1, name: 'User-agent parser' })).toBeVisible();
    await expect(page.getByText('Paste a user-agent string to see what it says.')).toBeVisible();
    await a11y.check(page, 'user-agent');
  });

  test('can be used with the keyboard alone', async ({ page }) => {
    await open(page);
    await expectKeyboardOnly(page, 'user-agent');
  });

  test('breaks a pasted string into its parts and announces a summary', async ({ page, a11y }) => {
    await open(page);
    await field(page).fill(CHROME_WINDOWS);
    await expect(row(page, 'Browser')).toContainText('Chrome 119.0.0.0');
    await expect(row(page, 'Engine')).toContainText('Blink 119.0.0.0');
    await expect(row(page, 'Operating system')).toContainText('Windows 10 or 11');
    await expect(row(page, 'Type')).toContainText('Computer');
    await expect(row(page, 'CPU architecture')).toContainText('x86-64');
    await expect(page.getByText(/Windows 10 and Windows 11 send the same version/)).toBeVisible();
    await a11y.check(page, 'user-agent: parsed');
    await field(page).press('Enter');
    await expect(status(page)).toHaveText('Chrome 119.0.0.0 on Windows 10 or 11, Computer');
    await a11y.check(page, 'user-agent: announced');
  });

  test('knows a phone, a crawler and a string it cannot read', async ({ page, a11y }) => {
    await open(page);
    await field(page).fill(IPHONE);
    await expect(row(page, 'Device')).toContainText('Apple iPhone');
    await expect(row(page, 'Type')).toContainText('Phone');
    await a11y.check(page, 'user-agent: phone');
    await field(page).fill(CRAWLER);
    await expect(row(page, 'Browser')).toContainText('Googlebot 2.1');
    await expect(row(page, 'Type')).toContainText('Crawler or bot');
    await a11y.check(page, 'user-agent: crawler');
    await field(page).fill('hello');
    await field(page).press('Enter');
    await expect(row(page, 'Browser')).toContainText('Not recognised');
    await expect(status(page)).toHaveText('Nothing in this string is recognised.');
    await a11y.check(page, 'user-agent: not recognised');
  });

  test('reads the own user agent only when asked, with the keyboard', async ({ page, a11y }) => {
    await open(page);
    await expect(field(page)).toHaveValue('');
    const own = await page.evaluate(() => navigator.userAgent);
    await page.getByRole('button', { name: 'Use my browser' }).focus();
    await page.keyboard.press('Enter');
    await expect(field(page)).toHaveValue(own);
    await expect(row(page, 'Browser')).not.toContainText('Not recognised');
    await expect(status(page)).not.toHaveText('');
    await a11y.check(page, 'user-agent: own');
    await page.getByRole('button', { name: 'Clear' }).focus();
    await page.keyboard.press('Enter');
    await expect(field(page)).toHaveValue('');
    await expect(page.getByRole('table')).toHaveCount(0);
    await expect(status(page)).toHaveText('');
  });

  test('refuses a text that is too long', async ({ page, a11y }) => {
    await open(page);
    await field(page).fill('x'.repeat(2001));
    await expect(field(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText(/too long for a user-agent string/)).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
    await a11y.check(page, 'user-agent: too long');
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
    await field(page).fill(CHROME_WINDOWS);
    await page.getByRole('button', { name: 'Copy result' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('region', { name: 'Notifications' })).toContainText(
      'Copied Result',
    );
    if (browserName === 'chromium') {
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      expect(JSON.parse(copied)).toMatchObject({ browser: { name: 'Chrome' }, cpu: 'x86-64' });
    }
    await a11y.check(page, 'user-agent: copied');
  });

  test('fits in 320 pixels without a horizontal scroll bar', async ({ page, a11y }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await open(page);
    await field(page).fill(CHROME_WINDOWS);
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
    await a11y.check(page, 'user-agent: phone');
  });
});

test.describe('user-agent in German', () => {
  test.use({ locale: 'de-DE' });

  test('shows the German texts and passes the gate', async ({ page, a11y }) => {
    await open(page);
    await expect(page.getByRole('heading', { level: 1, name: 'User-Agent-Parser' })).toBeVisible();
    await field(page).fill(IPHONE);
    await expect(row(page, 'Betriebssystem')).toContainText('iOS 17.1');
    await expect(row(page, 'Art')).toContainText('Smartphone');
    await a11y.check(page, 'user-agent: German');
  });
});
