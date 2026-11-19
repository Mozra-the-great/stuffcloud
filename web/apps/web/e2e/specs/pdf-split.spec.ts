import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import { expectKeyboardOnly } from '../support/keyboard.ts';
import {
  downloaded,
  drawnPages,
  expectReflow,
  makeEncryptedPdf,
  makePdf,
  pageWidths,
  pdfSample,
  zipEntry,
  zipNames,
} from '../support/pdf.ts';

// Split PDF in the built app, in Chromium and Firefox: by ranges, every N pages and a selection,
// results as single files and as one ZIP. The privacy check of the fixtures runs at the end of
// every test; every upload is registered with `net.watch`.

const NAME = 'Split PDF';

function status(page: Page): Locator {
  return page.locator('.live [role="status"]');
}

function alert(page: Page): Locator {
  return page.locator('.live [role="alert"]');
}

async function open(page: Page): Promise<void> {
  await page.goto('/tools/pdf-split');
  await expect(page.getByRole('heading', { level: 1, name: NAME, exact: true })).toBeVisible();
}

/** Opens a PDF of `count` pages (page `n` is `100 + n` points wide). */
async function openPdf(
  page: Page,
  net: { watch(file: Buffer): void },
  count: number,
): Promise<void> {
  const file = pdfSample('book.pdf', await makePdf(count));
  net.watch(file.buffer);
  await open(page);
  await page.locator('input[type="file"]').setInputFiles(file);
  await expect(status(page)).toHaveText(`book.pdf opened: ${String(count)} pages.`);
}

/** The pages in the grid (not the options of the select). */
function pages(page: Page): Locator {
  return page.getByRole('listbox', { name: 'Pages of book.pdf' }).getByRole('option');
}

function splitButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Split', exact: true });
}

test.describe('pdf-split', () => {
  test('opens with one heading and passes the accessibility gate', async ({ page, a11y }) => {
    await open(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await a11y.check(page, 'pdf-split empty');
  });

  test('can be used with the keyboard alone', async ({ page }) => {
    await open(page);
    await expectKeyboardOnly(page, 'pdf-split');
  });

  test('splits by ranges into files and one ZIP', async ({ page, net, a11y }) => {
    await openPdf(page, net, 6);
    await expect(splitButton(page)).toBeDisabled();
    await a11y.check(page, 'pdf-split opened');

    await page.getByLabel('Page ranges').fill('1-2, 4, 6-');
    await expect(page.getByText('This makes 3 files.')).toBeVisible();
    await a11y.check(page, 'pdf-split ranges typed');
    await splitButton(page).click();

    await expect(status(page)).toHaveText('Created 3 PDFs.');
    const files = page.getByRole('list', { name: 'Result files' }).getByRole('listitem');
    await expect(files).toHaveCount(3);
    await expect(files.nth(0)).toContainText('book_pages-1-2.pdf');
    await expect(files.nth(1)).toContainText('book_page-4.pdf');
    await expect(files.nth(2)).toContainText('book_page-6.pdf');
    await a11y.check(page, 'pdf-split done');

    const single = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download book_pages-1-2.pdf' }).click();
    expect(await pageWidths(await downloaded(await single))).toEqual([100, 101]);

    const archive = page.waitForEvent('download');
    await page.getByRole('link', { name: /^Download all as ZIP/ }).click();
    const zip = await downloaded(await archive);
    expect(zipNames(zip)).toEqual(['book_pages-1-2.pdf', 'book_page-4.pdf', 'book_page-6.pdf']);
    expect(await pageWidths(zipEntry(zip, 1))).toEqual([103]);
    expect(await pageWidths(zipEntry(zip, 2))).toEqual([105]);
  });

  test('splits every N pages', async ({ page, net }) => {
    await openPdf(page, net, 5);
    await page.getByLabel('Split by').selectOption('every');
    await page.getByLabel('Pages per file').fill('2');
    await expect(page.getByText('This makes 3 files.')).toBeVisible();
    await splitButton(page).click();
    await expect(status(page)).toHaveText('Created 3 PDFs.');
    const archive = page.waitForEvent('download');
    await page.getByRole('link', { name: /^Download all as ZIP/ }).click();
    const zip = await downloaded(await archive);
    expect(zipNames(zip)).toEqual(['book_part-1.pdf', 'book_part-2.pdf', 'book_part-3.pdf']);
    expect(await pageWidths(zipEntry(zip, 2))).toEqual([104]);
  });

  test('extracts the selected pages into one PDF, chosen with the keyboard', async ({
    page,
    net,
    a11y,
  }) => {
    await openPdf(page, net, 4);
    await page.getByLabel('Split by').selectOption('selection');
    await expect(pages(page)).toHaveCount(4);
    await expect.poll(() => drawnPages(page)).toBe(4);
    await expect(splitButton(page)).toBeDisabled();

    await pages(page).first().focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Space');
    await expect(page.locator('.hint', { hasText: '2 pages selected' })).toBeVisible();
    await a11y.check(page, 'pdf-split selection');

    await splitButton(page).click();
    await expect(status(page)).toHaveText('Created 1 PDF.');
    // One file: no ZIP.
    await expect(page.getByRole('link', { name: /ZIP/ })).toHaveCount(0);
    const download = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download book_selection.pdf' }).click();
    expect(await pageWidths(await downloaded(await download))).toEqual([101, 103]);
  });

  test('fits in 320 pixels in every mode', async ({ page, net }) => {
    await openPdf(page, net, 6);
    await expectReflow(page);
    await page.getByLabel('Split by').selectOption('selection');
    await expect(pages(page)).toHaveCount(6);
    await expectReflow(page);
  });

  test('says what is wrong with the ranges', async ({ page, net, a11y }) => {
    await openPdf(page, net, 3);
    const ranges = page.getByLabel('Page ranges');
    await ranges.fill('1-9');
    await expect(page.getByText('Page 9 does not exist: this PDF has 3 pages.')).toBeVisible();
    await expect(splitButton(page)).toBeDisabled();
    await a11y.check(page, 'pdf-split bad range');
    await ranges.fill('3-1');
    await expect(
      page.getByText('“3-1” runs backwards: write the smaller page first.'),
    ).toBeVisible();
    await ranges.fill('abc');
    await expect(page.getByText('“abc” is not a page or a range.')).toBeVisible();
    await ranges.fill('2');
    await expect(splitButton(page)).toBeEnabled();
  });

  test('refuses an every-N that does not fit the document', async ({ page, net }) => {
    await openPdf(page, net, 3);
    await page.getByLabel('Split by').selectOption('every');
    await page.getByLabel('Pages per file').fill('4');
    await expect(page.getByText('Enter a whole number from 1 to 3.')).toBeVisible();
    await expect(splitButton(page)).toBeDisabled();
  });

  test('says which problem an unusable file has', async ({ page, net, a11y }) => {
    const locked = pdfSample('locked.pdf', await makeEncryptedPdf());
    net.watch(locked.buffer);
    await open(page);
    await page.locator('input[type="file"]').setInputFiles(locked);
    await expect(alert(page)).toHaveText(
      'locked.pdf is protected with a password or encrypted. Remove the protection first, then try again.',
    );
    await expect(page.getByLabel('Split by')).toHaveCount(0);
    await a11y.check(page, 'pdf-split encrypted file');
  });

  test('works in German', async ({ page, net, a11y }) => {
    const file = pdfSample('book.pdf', await makePdf(4));
    net.watch(file.buffer);
    await page.addInitScript(() => {
      window.localStorage.setItem('stuffcloud.locale', 'de');
    });
    await page.goto('/tools/pdf-split');
    await expect(page.getByRole('heading', { level: 1, name: 'PDF teilen' })).toBeVisible();
    await page.locator('input[type="file"]').setInputFiles(file);
    await page.getByLabel('Seitenbereiche').fill('1-2');
    await expect(page.getByText('Das ergibt 1 Datei.')).toBeVisible();
    await a11y.check(page, 'pdf-split German');
    await page.getByRole('button', { name: 'Teilen', exact: true }).click();
    await expect(status(page)).toHaveText('1 PDF erstellt.');
    await a11y.check(page, 'pdf-split German done');
  });
});
