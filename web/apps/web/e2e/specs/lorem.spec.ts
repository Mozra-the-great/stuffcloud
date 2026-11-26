import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import { expectKeyboardOnly } from '../support/keyboard.ts';
import { expectNoHorizontalScroll } from '../support/reflow.ts';

// Lorem ipsum generator in the built app, in Chromium and Firefox (T-21, #26). The accessibility gate
// (T-05, #13) applies to every tool: `a11y.check` after each state, a keyboard route for each action,
// results in live regions.

async function open(page: Page): Promise<void> {
  await page.goto('/tools/lorem');
  await expect(
    page.getByRole('heading', {
      level: 1,
      name: /^(Lorem ipsum generator|Lorem-ipsum-Generator)$/,
    }),
  ).toBeVisible();
}

function text(page: Page): ReturnType<Page['getByRole']> {
  return page.getByRole('textbox', { name: /^(Placeholder text|Platzhaltertext)$/ });
}

/** The tool's own polite status line (the first one on the page is the search count). */
function status(page: Page): ReturnType<Page['locator']> {
  return page.locator('main [data-tool-status]');
}

test.describe('lorem', () => {
  test('opens with one heading, three paragraphs and passes the accessibility gate', async ({
    page,
    a11y,
  }) => {
    await open(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(text(page)).toHaveValue(
      /^Lorem ipsum dolor sit amet, consectetur adipiscing elit\./,
    );
    expect((await text(page).inputValue()).split('\n\n')).toHaveLength(3);
    await a11y.check(page, 'lorem');
  });

  test('can be used with the keyboard alone', async ({ page }) => {
    await open(page);
    await expectKeyboardOnly(page, 'lorem');
  });

  test('makes new text with the keyboard and announces it without reading it out', async ({
    page,
    a11y,
  }) => {
    await open(page);
    await expect(status(page)).toHaveText('');
    const first = await text(page).inputValue();
    await page.getByRole('button', { name: 'Generate new text' }).focus();
    await page.keyboard.press('Enter');
    await expect(text(page)).not.toHaveValue(first);
    await expect(status(page)).toHaveText('New text ready.');
    await a11y.check(page, 'lorem: new text');
  });

  test('follows the unit and the amount', async ({ page, a11y }) => {
    await open(page);
    await page.getByRole('combobox', { name: 'Unit' }).selectOption('words');
    await expect(page.getByRole('spinbutton', { name: 'Amount' })).toHaveValue('50');
    await page.getByRole('spinbutton', { name: 'Amount' }).fill('9');
    await expect(text(page)).toHaveValue(
      /^lorem ipsum dolor sit amet consectetur adipiscing elit \w+$/,
    );
    await page.getByRole('checkbox', { name: /Start with/ }).uncheck();
    expect((await text(page).inputValue()).split(' ')).toHaveLength(9);
    await a11y.check(page, 'lorem: nine words');
  });

  test('says what is wrong with the amount and shows no text', async ({ page, a11y }) => {
    await open(page);
    await page.getByRole('spinbutton', { name: 'Amount' }).fill('0');
    await expect(page.getByText('Enter a whole number from 1 to 200.')).toBeVisible();
    await expect(text(page)).toHaveValue('');
    await expect(page.getByRole('button', { name: 'Generate new text' })).toBeDisabled();
    await a11y.check(page, 'lorem: bad amount');
  });

  test('copies and downloads the text', async ({ page, context, browserName, a11y }) => {
    if (browserName === 'chromium') {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    }
    await open(page);
    const shown = await text(page).inputValue();
    await page.getByRole('button', { name: 'Copy text' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('region', { name: 'Notifications' })).toContainText(
      'Copied the text',
    );
    if (browserName === 'chromium') {
      // The clipboard of Windows has CRLF line ends.
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      expect(copied.replaceAll('\r\n', '\n')).toBe(shown);
    }
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download as .txt' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('lorem-ipsum.txt');
    await a11y.check(page, 'lorem: copied');
  });

  test('fits in 320 pixels without a horizontal scroll bar', async ({ page, a11y }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await open(page);
    await expectNoHorizontalScroll(page);
    await a11y.check(page, 'lorem: phone');
  });
});

test.describe('lorem in German', () => {
  test.use({ locale: 'de-DE' });

  test('shows the German texts and passes the gate', async ({ page, a11y }) => {
    await open(page);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Lorem-ipsum-Generator' }),
    ).toBeVisible();
    await page.getByRole('spinbutton', { name: 'Menge' }).fill('0');
    await expect(page.getByText('Gib eine ganze Zahl von 1 bis 200 ein.')).toBeVisible();
    await a11y.check(page, 'lorem: German');
  });
});
