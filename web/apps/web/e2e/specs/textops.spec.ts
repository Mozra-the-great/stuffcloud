import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import { setLongValue } from '../support/fill.ts';
import { expectKeyboardOnly } from '../support/keyboard.ts';
import { expectNoHorizontalScroll } from '../support/reflow.ts';

// Text tools in the built app, in Chromium and Firefox (T-21, #26). The accessibility gate (T-05, #13)
// applies to every tool: `a11y.check` after each state, a keyboard route for each action, results in
// live regions. The work runs in a worker that the page stops on a timeout.

async function open(page: Page): Promise<void> {
  await page.goto('/tools/textops');
  await expect(
    page.getByRole('heading', { level: 1, name: /^(Text tools|Textwerkzeuge)$/ }),
  ).toBeVisible();
  await expect(result(page)).not.toHaveValue('');
}

function input(page: Page): ReturnType<Page['getByRole']> {
  return page.getByRole('textbox', { name: /^(Your text|Dein Text)$/ });
}

function result(page: Page): ReturnType<Page['getByRole']> {
  return page.getByRole('textbox', { name: /^(Result text|Ergebnistext)$/ });
}

/** The tool's own polite status line and its alert (the first live region on the page is the search count). */
function status(page: Page): ReturnType<Page['locator']> {
  return page.locator('main [data-tool-status][role="status"]');
}

function alert(page: Page): ReturnType<Page['locator']> {
  return page.locator('main [data-tool-status][role="alert"]');
}

test.describe('textops', () => {
  test('opens with one heading, converts to upper case and passes the accessibility gate', async ({
    page,
    a11y,
  }) => {
    await open(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(result(page)).toHaveValue(/^HELLO WORLD\nHELLO WORLD\nZEBRA\n/);
    await expect(page.locator('.counts .count')).toHaveCount(6);
    await a11y.check(page, 'textops: case');
  });

  test('can be used with the keyboard alone', async ({ page }) => {
    await open(page);
    await expectKeyboardOnly(page, 'textops');
  });

  test('counts characters, words and lines while typing', async ({ page, a11y }) => {
    await open(page);
    await input(page).fill('Hello world\n\nSecond paragraph here\nstill second\n');
    const count = (label: string): ReturnType<Page['locator']> =>
      page.locator('.counts .count', { hasText: label }).locator('dd');
    await expect(count('Words')).toHaveText('7');
    await expect(count('Lines')).toHaveText('4');
    await expect(count('Paragraphs')).toHaveText('2');
    await expect(count('Bytes')).toHaveText('48');
    await a11y.check(page, 'textops: counts');
  });

  test('sorts, removes duplicates and announces how many it removed, with the keyboard', async ({
    page,
    a11y,
  }) => {
    await open(page);
    await input(page).fill('b\na\nB\na\n10\n9');
    const operation = page.getByRole('combobox', { name: 'What to do' });
    await operation.focus();
    await operation.selectOption('sort');
    await expect(result(page)).toHaveValue('9\n10\na\na\nb\nB');
    await a11y.check(page, 'textops: sort');
    await operation.selectOption('dedupe');
    await expect(result(page)).toHaveValue('b\na\nB\n10\n9');
    await expect(status(page)).toHaveText('1 duplicate line removed.');
    await a11y.check(page, 'textops: dedupe');
  });

  test('trims, numbers lines and makes slugs', async ({ page, a11y }) => {
    await open(page);
    await input(page).fill('  Crème Brûlée  \n  Größe!  ');
    const operation = page.getByRole('combobox', { name: 'What to do' });
    await operation.selectOption('trim');
    await expect(result(page)).toHaveValue('Crème Brûlée\nGröße!');
    await a11y.check(page, 'textops: trim');
    await operation.selectOption('number');
    await expect(result(page)).toHaveValue('1:   Crème Brûlée  \n2:   Größe!  ');
    await a11y.check(page, 'textops: number');
    await operation.selectOption('slug');
    await expect(result(page)).toHaveValue('creme-brulee\ngrosse');
    await a11y.check(page, 'textops: slug');
  });

  test('says what is wrong with the first number', async ({ page, a11y }) => {
    await open(page);
    await page.getByRole('combobox', { name: 'What to do' }).selectOption('number');
    await page.getByRole('spinbutton', { name: 'First number' }).fill('1.5');
    await expect(
      page.getByText('Enter a whole number, at most 1,000,000,000 in size.'),
    ).toBeVisible();
    await expect(result(page)).toHaveValue('');
    await a11y.check(page, 'textops: bad number');
  });

  test('finds and replaces, with groups of a regular expression, and says how many', async ({
    page,
    a11y,
  }) => {
    await open(page);
    await input(page).fill('2026-11-19 and 2027-01-02');
    await page.getByRole('combobox', { name: 'What to do' }).selectOption('replace');
    await page.getByRole('checkbox', { name: 'Regular expression' }).check();
    await page.getByRole('textbox', { name: 'Find' }).fill(String.raw`(\d+)-(\d+)-(\d+)`);
    await page.getByRole('textbox', { name: 'Replace with' }).fill('$3.$2.$1');
    await expect(result(page)).toHaveValue('19.11.2026 and 02.01.2027');
    await expect(status(page)).toHaveText('2 matches replaced.');
    await a11y.check(page, 'textops: replace');
    await page.getByRole('textbox', { name: 'Find' }).fill('(');
    await expect(page.locator('.k-field .error')).toContainText('This pattern does not work');
    await a11y.check(page, 'textops: bad pattern');
  });

  test('replaces a plain hyphen, which is no special character', async ({ page, a11y }) => {
    await open(page);
    await input(page).fill('2024-01-02');
    await page.getByRole('combobox', { name: 'What to do' }).selectOption('replace');
    await page.getByRole('textbox', { name: 'Find' }).fill('-');
    await page.getByRole('textbox', { name: 'Replace with' }).fill('/');
    await expect(result(page)).toHaveValue('2024/01/02');
    await expect(status(page)).toHaveText('2 matches replaced.');
    await a11y.check(page, 'textops: plain replace');
  });

  test('stops a pattern that never ends and stays usable', async ({ page, a11y }) => {
    test.setTimeout(60_000);
    await open(page);
    await input(page).fill(`${'a'.repeat(40)}b`);
    await page.getByRole('combobox', { name: 'What to do' }).selectOption('replace');
    await page.getByRole('checkbox', { name: 'Regular expression' }).check();
    await page.getByRole('textbox', { name: 'Find' }).fill('(a+)+$');
    await page.getByRole('textbox', { name: 'Replace with' }).fill('x');
    await expect(alert(page)).toHaveText(
      'Stopped after 5 seconds. Use a simpler pattern or a shorter text.',
      { timeout: 30_000 },
    );
    await a11y.check(page, 'textops: stopped');
    // The page recovers with the next edit.
    await page.getByRole('textbox', { name: 'Find' }).fill('a+');
    await expect(alert(page)).toHaveText('');
    await expect(result(page)).toHaveValue('xb');
  });

  test('uses the result as the text and copies and downloads it', async ({
    page,
    context,
    browserName,
    a11y,
  }) => {
    if (browserName === 'chromium') {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    }
    await open(page);
    await input(page).fill('abc');
    await expect(result(page)).toHaveValue('ABC');
    await page.getByRole('button', { name: 'Copy result' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('region', { name: 'Notifications' })).toContainText(
      'Copied the result',
    );
    if (browserName === 'chromium') {
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('ABC');
    }
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download as .txt' }).click();
    expect((await download).suggestedFilename()).toBe('text.txt');
    await page.getByRole('button', { name: 'Use result as text' }).click();
    await expect(input(page)).toHaveValue('ABC');
    await expect(status(page)).toHaveText('The result is now the text.');
    await a11y.check(page, 'textops: result used');
  });

  test('works on a text of 30,000 lines without freezing the page', async ({ page, a11y }) => {
    test.setTimeout(90_000);
    await open(page);
    const big = Array.from({ length: 30_000 }, (_, index) => `Line ${String(index % 977)}`).join(
      '\n',
    );
    expect(big.length).toBeGreaterThan(250_000);
    await setLongValue(input(page), big);
    await expect(page.locator('.counts .count', { hasText: 'Lines' }).locator('dd')).toHaveText(
      '30,000',
      { timeout: 30_000 },
    );
    await page.getByRole('combobox', { name: 'What to do' }).selectOption('dedupe');
    await expect(status(page)).toHaveText('29,023 duplicate lines removed.', { timeout: 30_000 });
    await a11y.check(page, 'textops: large text');
  });

  test('fits in 320 pixels without a horizontal scroll bar', async ({ page, a11y }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await open(page);
    await expectNoHorizontalScroll(page);
    await a11y.check(page, 'textops: phone');
  });
});

test.describe('textops in German', () => {
  test.use({ locale: 'de-DE' });

  test('shows the German texts and passes the gate', async ({ page, a11y }) => {
    await open(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Textwerkzeuge' })).toBeVisible();
    await page.getByRole('combobox', { name: 'Was tun' }).selectOption('slug');
    await input(page).fill('Größe über Äpfel');
    await expect(result(page)).toHaveValue('groesse-ueber-aepfel');
    await a11y.check(page, 'textops: German');
  });
});
