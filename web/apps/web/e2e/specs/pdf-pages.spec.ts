import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import { expectKeyboardOnly } from '../support/keyboard.ts';
import {
  downloaded,
  drawnPages,
  expectReflow,
  makeEncryptedPdf,
  makePdf,
  pageRotations,
  pageWidths,
  pdfSample,
} from '../support/pdf.ts';

// Rotate, delete and reorder PDF pages in the built app, in Chromium and Firefox: pictures of the
// pages are drawn in a worker, every action has a keyboard route and is announced, undo and redo
// work, and the saved file has the pages the grid showed. The privacy check of the fixtures runs at
// the end of every test; every upload is registered with `net.watch`.

const NAME = 'Rotate, delete, reorder PDF pages';

function status(page: Page): Locator {
  return page.locator('.live [role="status"]');
}

/** The visible hint paragraphs (the live region repeats some of them for screen readers). */
function hint(page: Page, text: string): Locator {
  return page.locator('.hint', { hasText: text });
}

function options(page: Page): Locator {
  return page.getByRole('option');
}

function button(page: Page, name: string): Locator {
  return page.getByRole('button', { name, exact: true });
}

async function open(page: Page): Promise<void> {
  await page.goto('/tools/pdf-pages');
  await expect(page.getByRole('heading', { level: 1, name: NAME, exact: true })).toBeVisible();
}

/** Opens a PDF of `count` pages (page `n` is `100 + n` points wide) and waits for the grid. */
async function openPdf(
  page: Page,
  net: { watch(file: Buffer): void },
  count: number,
  name = 'doc.pdf',
): Promise<void> {
  const file = pdfSample(name, await makePdf(count));
  net.watch(file.buffer);
  await open(page);
  await page.locator('input[type="file"]').setInputFiles(file);
  await expect(options(page)).toHaveCount(count);
}

async function save(page: Page): Promise<Buffer> {
  await button(page, 'Save PDF').click();
  const link = page.getByRole('link', { name: /^Download doc_edited\.pdf$/ });
  await expect(link).toBeVisible();
  const download = page.waitForEvent('download');
  await link.click();
  return downloaded(await download);
}

test.describe('pdf-pages', () => {
  test('opens with one heading and passes the accessibility gate', async ({ page, a11y }) => {
    await open(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await a11y.check(page, 'pdf-pages empty');
  });

  test('can be used with the keyboard alone', async ({ page }) => {
    await open(page);
    await expectKeyboardOnly(page, 'pdf-pages');
  });

  test('draws a picture of every page in a worker', async ({ page, net, a11y }) => {
    await openPdf(page, net, 4);
    await expect(status(page)).toHaveText('doc.pdf opened: 4 pages.');
    await expect.poll(() => drawnPages(page)).toBe(4);
    // Pages are decoded in dedicated workers of the page, not on its thread.
    expect(page.workers().length).toBeGreaterThan(0);
    await a11y.check(page, 'pdf-pages with pages');
  });

  test('turns, deletes and moves pages with the keyboard, announces each step and saves the result', async ({
    page,
    net,
    a11y,
  }) => {
    await openPdf(page, net, 4);
    await expect(options(page).nth(0)).toHaveAccessibleName('Position 1: page 1');

    // One Tab stop into the grid; arrows move, Space selects.
    await options(page).first().focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Space');
    await expect(options(page).nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(hint(page, '1 page selected')).toBeVisible();

    await button(page, 'Turn right').click();
    await expect(status(page)).toHaveText('Turned 1 page right.');
    await expect(options(page).nth(1)).toHaveAccessibleName(
      'Position 2: page 2, turned 90 degrees clockwise',
    );
    await a11y.check(page, 'pdf-pages after a turn');

    // Alt+arrow moves the focused page: page 2 goes after page 3.
    await options(page).nth(1).focus();
    await page.keyboard.press('Alt+ArrowRight');
    await expect(options(page).nth(2)).toHaveAccessibleName(
      'Position 3: page 2, turned 90 degrees clockwise',
    );
    await expect(status(page)).toHaveText('Moved 1 page to position 3.');
    await expect(options(page).nth(2)).toBeFocused();

    // The moved page is still the selected one: delete it.
    await button(page, 'Delete').click();
    await expect(status(page)).toHaveText('Deleted 1 page.');
    await expect(options(page)).toHaveCount(3);

    await a11y.check(page, 'pdf-pages after a delete');

    // Undo (Ctrl+Z) brings the page back, with its turn.
    await page.keyboard.press('Control+z');
    await expect(status(page)).toHaveText('Undone: Deleted 1 page.');
    await expect(options(page)).toHaveCount(4);
    await page.keyboard.press('Control+Shift+z');
    await expect(status(page)).toHaveText('Redone: Deleted 1 page.');
    await expect(options(page)).toHaveCount(3);
    await button(page, 'Undo').click();
    await button(page, 'Undo').click();
    await button(page, 'Undo').click();
    await expect(options(page)).toHaveCount(4);
    await expect(status(page)).toHaveText('Undone: Turned 1 page right.');
    // A button that has nothing to do stays focusable (aria-disabled), so the click is forced.
    await button(page, 'Undo').click({ force: true });
    await expect(status(page)).toHaveText('Nothing to undo.');
    await button(page, 'Redo').click();
    await button(page, 'Redo').click();
    await button(page, 'Redo').click();
    await expect(status(page)).toHaveText('Redone: Deleted 1 page.');

    await a11y.check(page, 'pdf-pages after undo and redo');
    const saved = await save(page);
    // The page that was turned, moved and then deleted is gone: pages 1, 3 and 4 remain.
    expect(await pageWidths(saved)).toEqual([100, 102, 103]);
    expect(await pageRotations(saved)).toEqual([0, 0, 0]);
  });

  test('saves turned and reordered pages in the file', async ({ page, net }) => {
    await openPdf(page, net, 5);
    // Turn pages 1 and 2 left, then move page 5 to the start.
    await options(page).nth(0).click();
    await options(page).nth(1).click();
    await button(page, 'Turn left').click();
    await expect(status(page)).toHaveText('Turned 2 pages left.');
    await button(page, 'Select none').click();
    await options(page).nth(4).click();
    await button(page, 'To the start').click();
    await expect(status(page)).toHaveText('Moved 1 page to the start.');

    const saved = await save(page);
    expect(await pageWidths(saved)).toEqual([104, 100, 101, 102, 103]);
    expect(await pageRotations(saved)).toEqual([0, 270, 270, 0, 0]);
  });

  test('moves selected pages to a position that is typed', async ({ page, net }) => {
    await openPdf(page, net, 5);
    await options(page).nth(0).click();
    await options(page).nth(1).click();
    await page.getByLabel('Move selected pages to position').fill('4');
    await page.keyboard.press('Enter');
    await expect(status(page)).toHaveText('Moved 2 pages to position 4.');
    const saved = await save(page);
    expect(await pageWidths(saved)).toEqual([102, 103, 104, 100, 101]);
  });

  test('refuses a position that does not exist and an action without a selection', async ({
    page,
    net,
    a11y,
  }) => {
    await openPdf(page, net, 3);
    await button(page, 'Delete').click({ force: true });
    await expect(page.locator('.live [role="alert"]')).toHaveText(
      'Select one or more pages first.',
    );
    await a11y.check(page, 'pdf-pages needs a selection');

    await options(page).nth(0).click();
    await page.getByLabel('Move selected pages to position').fill('9');
    await page.keyboard.press('Enter');
    await expect(page.getByText('Enter a whole number from 1 to 3.')).toBeVisible();
    await a11y.check(page, 'pdf-pages bad position');
  });

  test('moves a page by drag and drop', async ({ page, net }) => {
    await openPdf(page, net, 4);
    await options(page).nth(0).dragTo(options(page).nth(2));
    await expect(options(page).nth(2)).toHaveAccessibleName('Position 3: page 1');
    const saved = await save(page);
    expect(await pageWidths(saved)).toEqual([101, 102, 100, 103]);
  });

  test('fits in 320 pixels with a document open and a page selected', async ({ page, net }) => {
    await openPdf(page, net, 6);
    await options(page).nth(1).click();
    await expectReflow(page);
  });

  test('selects all with Ctrl+A and clears with Escape', async ({ page, net }) => {
    await openPdf(page, net, 3);
    await options(page).first().focus();
    await page.keyboard.press('Control+a');
    await expect(hint(page, '3 pages selected')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(hint(page, '0 pages selected')).toBeVisible();
    await button(page, 'Select all').click();
    await expect(hint(page, '3 pages selected')).toBeVisible();
    await button(page, 'Select none').click();
    await expect(hint(page, '0 pages selected')).toBeVisible();
  });

  test('says when every page is deleted and does not save an empty file', async ({ page, net }) => {
    await openPdf(page, net, 2);
    await button(page, 'Select all').click();
    await button(page, 'Delete').click();
    await expect(page.getByText('All pages are deleted. Undo to bring them back.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save PDF', exact: true })).toBeDisabled();
  });

  test('says which problem an unusable file has', async ({ page, net, a11y }) => {
    const locked = pdfSample('locked.pdf', await makeEncryptedPdf());
    net.watch(locked.buffer);
    await open(page);
    await page.locator('input[type="file"]').setInputFiles(locked);
    await expect(page.locator('.live [role="alert"]')).toHaveText(
      'locked.pdf is protected with a password or encrypted. Remove the protection first, then try again.',
    );
    await expect(options(page)).toHaveCount(0);
    await a11y.check(page, 'pdf-pages encrypted file');
  });

  test('works in German', async ({ page, net, a11y }) => {
    const file = pdfSample('doc.pdf', await makePdf(3));
    net.watch(file.buffer);
    await page.addInitScript(() => {
      window.localStorage.setItem('stuffcloud.locale', 'de');
    });
    await page.goto('/tools/pdf-pages');
    await expect(
      page.getByRole('heading', { level: 1, name: 'PDF-Seiten drehen, löschen, sortieren' }),
    ).toBeVisible();
    await page.locator('input[type="file"]').setInputFiles(file);
    await expect(options(page)).toHaveCount(3);
    await options(page).nth(1).click();
    await page.getByRole('button', { name: 'Nach rechts drehen' }).click();
    await expect(options(page).nth(1)).toHaveAccessibleName(
      'Position 2: Seite 2, 90 Grad im Uhrzeigersinn gedreht',
    );
    await a11y.check(page, 'pdf-pages German');
  });

  test('keeps a page of 60 pages usable: all pictures come, Tab needs few stops', async ({
    page,
    net,
  }) => {
    await openPdf(page, net, 60);
    await expect.poll(() => drawnPages(page), { timeout: 30_000 }).toBe(60);
    const stops = await page.evaluate(
      () =>
        [...document.querySelectorAll<HTMLElement>('[role="option"]')].filter(
          (option) => option.tabIndex === 0,
        ).length,
    );
    expect(stops).toBe(1);
  });
});
