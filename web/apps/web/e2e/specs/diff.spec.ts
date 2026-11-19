import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import { setLongValue } from '../support/fill.ts';
import { expectKeyboardOnly } from '../support/keyboard.ts';
import { expectNoHorizontalScroll } from '../support/reflow.ts';

// Text diff in the built app, in Chromium and Firefox (T-21, #26). The accessibility gate (T-05, #13)
// applies to every tool: `a11y.check` after each state, a keyboard route for each action, results in
// live regions. The comparison runs in a worker: the large-text tests prove that the page stays usable.

async function open(page: Page): Promise<void> {
  await page.goto('/tools/diff');
  await expect(
    page.getByRole('heading', { level: 1, name: /^(Text diff|Text-Vergleich)$/ }),
  ).toBeVisible();
}

function original(page: Page): ReturnType<Page['getByRole']> {
  return page.getByRole('textbox', { name: /^(Original)$/ });
}

function changed(page: Page): ReturnType<Page['getByRole']> {
  return page.getByRole('textbox', { name: /^(Changed|Geändert)$/ });
}

/** The tool's own polite status line (the first one on the page is the search count). */
function status(page: Page): ReturnType<Page['locator']> {
  return page.locator('main .tool-status:not(.alert)');
}

function lines(count: number, seed: number): string {
  let state = seed;
  const out: string[] = [];
  for (let index = 0; index < count; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out.push(`line ${String(index)} ${state.toString(36)} lorem ipsum dolor sit amet consectetur`);
  }
  return out.join('\n');
}

test.describe('diff', () => {
  test('opens with one heading, compares the example texts and passes the accessibility gate', async ({
    page,
    a11y,
  }) => {
    await open(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(status(page)).toHaveText('Lines: 2 added, 1 removed.');
    await expect(page.getByRole('table', { name: 'Differences, side by side' })).toBeVisible();
    await expect(page.locator('table.diff del')).toHaveText('brown');
    await expect(page.locator('table.diff ins').first()).toHaveText('red');
    await a11y.check(page, 'diff: side by side');
  });

  test('can be used with the keyboard alone', async ({ page }) => {
    await open(page);
    await expect(status(page)).not.toHaveText('');
    await expectKeyboardOnly(page, 'diff');
  });

  test('switches to the inline view and to words with the keyboard', async ({ page, a11y }) => {
    await open(page);
    await expect(status(page)).not.toHaveText('');
    const view = page.getByRole('combobox', { name: 'View' });
    await view.focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('table', { name: 'Differences, inline' })).toBeVisible();
    await a11y.check(page, 'diff: inline');
    await page.getByRole('combobox', { name: 'Compare by' }).selectOption('words');
    await expect(status(page)).toHaveText('Words: 3 added, 1 removed.');
    await expect(page.locator('p.flow del')).toHaveText('brown');
    await a11y.check(page, 'diff: words inline');
    await view.selectOption('side-by-side');
    await expect(page.locator('.flow-box')).toHaveCount(2);
    await a11y.check(page, 'diff: words side by side');
  });

  test('says when the texts are identical, and when white space is the only difference', async ({
    page,
    a11y,
  }) => {
    await open(page);
    await original(page).fill('a  b\nc');
    await changed(page).fill('a b\n  c');
    await expect(status(page)).toHaveText('Lines: 2 added, 2 removed.');
    await page.getByRole('checkbox', { name: 'Ignore white space' }).check();
    await expect(status(page)).toHaveText('The texts are identical.');
    await expect(page.locator('table.diff')).toHaveCount(0);
    await a11y.check(page, 'diff: identical');
  });

  test('folds unchanged lines and shows them on request', async ({ page, a11y }) => {
    await open(page);
    const before = lines(60, 1);
    await original(page).fill(before);
    await changed(page).fill(before.replace('line 30 ', 'line thirty '));
    await expect(page.locator('tr.skipped').first()).toBeVisible();
    await expect(page.locator('tr.skipped').first()).toContainText('unchanged lines');
    await a11y.check(page, 'diff: folded');
    await page.getByRole('checkbox', { name: 'Show unchanged lines too' }).check();
    await expect(page.locator('tr.skipped')).toHaveCount(0);
    await expect(page.locator('table.diff tbody tr')).toHaveCount(60);
    await a11y.check(page, 'diff: all lines');
  });

  test('compares two texts of 1 MB with a hundred edits and stays usable', async ({
    page,
    a11y,
  }) => {
    test.setTimeout(90_000);
    await open(page);
    const before = lines(20_000, 1);
    expect(before.length).toBeGreaterThan(1_000_000);
    const after = before
      .split('\n')
      .map((line, index) => (index % 200 === 0 ? `${line} edited` : line))
      .join('\n');
    await setLongValue(original(page), before);
    await setLongValue(changed(page), after);
    await expect(status(page)).toHaveText('Lines: 100 added, 100 removed.', { timeout: 30_000 });
    // The page answers while and after the work: a control still reacts at once.
    await page.getByRole('checkbox', { name: 'Ignore white space' }).check();
    await expect(page.getByRole('checkbox', { name: 'Ignore white space' })).toBeChecked();
    await expect(status(page)).toHaveText('Lines: 100 added, 100 removed.', { timeout: 30_000 });
    await a11y.check(page, 'diff: 1 MB');
  });

  test('shows two very different texts of 1 MB as replaced instead of freezing', async ({
    page,
    a11y,
  }) => {
    test.setTimeout(120_000);
    await open(page);
    await setLongValue(original(page), lines(20_000, 1));
    await setLongValue(changed(page), lines(20_000, 2));
    await expect(
      page.getByText(
        'The texts share too little to be lined up in the time allowed, so everything is shown as replaced.',
      ),
    ).toBeVisible({ timeout: 60_000 });
    await expect(status(page)).toHaveText('Lines: 20,000 added, 20,000 removed.');
    await expect(page.getByText('Only the first 1,000 rows are shown.')).toBeVisible();
    // Still responsive: a control reacts at once.
    await page.getByRole('combobox', { name: 'View' }).selectOption('inline');
    await expect(page.getByRole('table', { name: 'Differences, inline' })).toBeVisible({
      timeout: 30_000,
    });
    await a11y.check(page, 'diff: replaced');
  });

  test('refuses a text over the limit and says so', async ({ page, a11y }) => {
    await open(page);
    await setLongValue(original(page), 'x'.repeat(2_000_001));
    await expect(page.getByText('This text is longer than 2,000,000 characters.')).toBeVisible();
    await expect(page.locator('table.diff')).toHaveCount(0);
    await a11y.check(page, 'diff: too long');
  });

  test('fits in 320 pixels without a horizontal scroll bar', async ({ page, a11y }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await open(page);
    await original(page).fill('a very long line without any spaces '.repeat(6) + 'x');
    await changed(page).fill('a very long line without any spaces '.repeat(6) + 'y');
    await expect(page.locator('table.diff')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await a11y.check(page, 'diff: phone');
  });
});

test.describe('diff in German', () => {
  test.use({ locale: 'de-DE' });

  test('shows the German texts and passes the gate', async ({ page, a11y }) => {
    await open(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Text-Vergleich' })).toBeVisible();
    await expect(status(page)).toHaveText('Zeilen: 2 hinzugekommen, 1 entfernt.');
    await a11y.check(page, 'diff: German');
  });
});
