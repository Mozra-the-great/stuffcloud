import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import { expectKeyboardOnly } from '../support/keyboard.ts';
import {
  downloaded,
  expectReflow,
  makeEncryptedPdf,
  makePdf,
  pageWidths,
  pdfSample,
} from '../support/pdf.ts';

// Merge PDFs in the built app, in Chromium and Firefox: the files are merged in a worker, in the
// order the list shows, with buttons or drag and drop, and nothing leaves the page (the privacy
// check of the fixtures runs at the end of every test; every upload is registered with `net.watch`).

const NAME = 'Merge PDFs';
const LIST = 'PDFs to merge, in this order';

function status(page: Page): ReturnType<Page['locator']> {
  return page.locator('.live [role="status"]');
}

function alert(page: Page): ReturnType<Page['locator']> {
  return page.locator('.live [role="alert"]');
}

function names(page: Page): ReturnType<Page['locator']> {
  return page.getByRole('list', { name: LIST }).locator('.name');
}

async function open(page: Page): Promise<void> {
  await page.goto('/tools/pdf-merge');
  await expect(page.getByRole('heading', { level: 1, name: NAME, exact: true })).toBeVisible();
}

async function upload(page: Page, ...files: ReturnType<typeof pdfSample>[]): Promise<void> {
  await page.locator('input[type="file"]').setInputFiles(files);
}

test.describe('pdf-merge', () => {
  test('opens with one heading and passes the accessibility gate', async ({ page, a11y }) => {
    await open(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Merge', exact: true })).toBeDisabled();
    await expect(page.getByText('Add at least two PDFs to merge them.')).toBeVisible();
    await a11y.check(page, 'pdf-merge empty');
  });

  test('can be used with the keyboard alone', async ({ page }) => {
    await open(page);
    await expectKeyboardOnly(page, 'pdf-merge');
  });

  test('merges two files in the order of the list, moved with the buttons', async ({
    page,
    net,
    a11y,
  }) => {
    const a = pdfSample('a.pdf', await makePdf(2)); // widths 100, 101
    const b = pdfSample('b.pdf', await makePdf([{ width: 200 }, { width: 201 }, { width: 202 }]));
    net.watch(a.buffer);
    net.watch(b.buffer);
    await open(page);
    await upload(page, a, b);

    await expect(names(page)).toHaveText(['a.pdf', 'b.pdf']);
    await expect(page.getByText('2 pages ·')).toBeVisible();
    await expect(page.getByText('3 pages ·')).toBeVisible();
    await expect(status(page)).toHaveText('2 PDFs added.');
    await a11y.check(page, 'pdf-merge with two files');

    // Keyboard route: the button of b.pdf, pressed with Enter, puts b first; the focus stays on it.
    const up = page.getByRole('button', { name: 'Move b.pdf up' });
    await up.focus();
    await page.keyboard.press('Enter');
    await expect(names(page)).toHaveText(['b.pdf', 'a.pdf']);
    await expect(status(page)).toHaveText('b.pdf is now number 1 of 2.');
    // The button is disabled now that b.pdf is first: the focus moved to its partner.
    await expect(page.getByRole('button', { name: 'Move b.pdf down' })).toBeFocused();
    await a11y.check(page, 'pdf-merge after a move');

    await page.getByRole('button', { name: 'Merge', exact: true }).click();
    const link = page.getByRole('link', { name: 'Download merged.pdf' });
    await expect(link).toBeVisible();
    await expect(status(page)).toHaveText(/^Merged 2 files into one PDF: 5 pages, /);
    await a11y.check(page, 'pdf-merge done');

    const download = page.waitForEvent('download');
    await link.click();
    const merged = await downloaded(await download);
    expect(await pageWidths(merged)).toEqual([200, 201, 202, 100, 101]);
  });

  test('moves a file by drag and drop', async ({ page, net }) => {
    const files = [
      pdfSample('one.pdf', await makePdf(1)),
      pdfSample('two.pdf', await makePdf([{ width: 150 }])),
      pdfSample('three.pdf', await makePdf([{ width: 160 }])),
    ];
    for (const file of files) {
      net.watch(file.buffer);
    }
    await open(page);
    await upload(page, ...files);
    await expect(names(page)).toHaveText(['one.pdf', 'two.pdf', 'three.pdf']);

    const items = page.getByRole('list', { name: LIST }).getByRole('listitem');
    await items.nth(2).dragTo(items.nth(0));
    await expect(names(page)).toHaveText(['three.pdf', 'one.pdf', 'two.pdf']);

    await expect(page.getByText('3 PDFs added.')).toHaveCount(0);
    await page.getByRole('button', { name: 'Merge', exact: true }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download merged.pdf' }).click();
    expect(await pageWidths(await downloaded(await download))).toEqual([160, 100, 150]);
  });

  test('fits in 320 pixels with files in the list', async ({ page, net }) => {
    const a = pdfSample('a-file-with-a-rather-long-name-for-a-small-screen.pdf', await makePdf(1));
    const b = pdfSample('b.pdf', await makePdf(1));
    net.watch(a.buffer);
    net.watch(b.buffer);
    await open(page);
    await upload(page, a, b);
    await expect(names(page)).toHaveCount(2);
    await expectReflow(page);
  });

  test('removes a file and everything at once', async ({ page, net }) => {
    const a = pdfSample('a.pdf', await makePdf(1));
    const b = pdfSample('b.pdf', await makePdf(1));
    net.watch(a.buffer);
    net.watch(b.buffer);
    await open(page);
    await upload(page, a, b);
    await expect(names(page)).toHaveText(['a.pdf', 'b.pdf']);

    await page.getByRole('button', { name: 'Remove a.pdf' }).click();
    await expect(names(page)).toHaveText(['b.pdf']);
    await expect(status(page)).toHaveText('a.pdf removed.');
    await expect(page.getByRole('button', { name: 'Merge', exact: true })).toBeDisabled();

    await page.getByRole('button', { name: 'Remove all' }).click();
    await expect(page.getByRole('list', { name: LIST })).toHaveCount(0);
    await expect(status(page)).toHaveText('All files removed.');
  });

  test('says which file is encrypted and keeps the others usable', async ({ page, net, a11y }) => {
    const good = pdfSample('good.pdf', await makePdf(1));
    const locked = pdfSample('locked.pdf', await makeEncryptedPdf());
    const broken = pdfSample('broken.pdf', Buffer.from('this is not a pdf'));
    for (const file of [good, locked, broken]) {
      net.watch(file.buffer);
    }
    await open(page);
    await upload(page, good, locked, broken);

    await expect(
      page.getByText(
        'locked.pdf is protected with a password or encrypted. Remove the protection first, then try again.',
      ),
    ).toBeVisible();
    await expect(
      page.getByText('broken.pdf could not be read: it is damaged or not a PDF.'),
    ).toBeVisible();
    // Only one file is usable, so there is nothing to merge yet.
    await expect(page.getByRole('button', { name: 'Merge', exact: true })).toBeDisabled();
    await a11y.check(page, 'pdf-merge with unusable files');
  });

  test('skips files that are not PDFs and says so', async ({ page, a11y }) => {
    await open(page);
    // A dropped file is not filtered by the browser: the tool reports what it skipped.
    await page.getByRole('group', { name: 'Drop PDFs here' }).evaluate((zone) => {
      const data = new DataTransfer();
      data.items.add(new File(['x'], 'a.txt', { type: 'text/plain' }));
      data.items.add(new File(['y'], 'b.txt', { type: 'text/plain' }));
      zone.dispatchEvent(
        new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }),
      );
    });
    await expect(alert(page)).toHaveText('2 files were skipped because they are not PDFs.');
    await a11y.check(page, 'pdf-merge rejected files');
  });

  test('works in German', async ({ page, net, a11y }) => {
    const a = pdfSample('a.pdf', await makePdf(1));
    const b = pdfSample('b.pdf', await makePdf(1));
    net.watch(a.buffer);
    net.watch(b.buffer);
    await page.addInitScript(() => {
      window.localStorage.setItem('stuffcloud.locale', 'de');
    });
    await page.goto('/tools/pdf-merge');
    await expect(page.getByRole('heading', { level: 1, name: 'PDFs zusammenfügen' })).toBeVisible();
    await upload(page, a, b);
    await expect(page.getByRole('button', { name: 'b.pdf nach oben' })).toBeVisible();
    await a11y.check(page, 'pdf-merge German');
    await page.getByRole('button', { name: 'Zusammenfügen', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Herunterladen merged.pdf' })).toBeVisible();
  });

  test('keeps working while a merge runs: the page still answers', async ({ page, net }) => {
    // 30 files of 40 pages: enough work that a merge on the page itself would stall the frames.
    const bytes = await makePdf(40);
    const files = Array.from({ length: 30 }, (_, n) => pdfSample(`f${String(n)}.pdf`, bytes));
    net.watch(files[0]?.buffer ?? Buffer.alloc(0));
    await open(page);
    await upload(page, ...files);
    await expect(page.getByRole('button', { name: 'Merge', exact: true })).toBeEnabled();
    await page.evaluate(() => {
      const state = { last: performance.now(), worst: 0 };
      const tick = (): void => {
        const now = performance.now();
        state.worst = Math.max(state.worst, now - state.last);
        state.last = now;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      (window as unknown as { __frames: typeof state }).__frames = state;
    });
    await page.getByRole('button', { name: 'Merge', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Download merged.pdf' })).toBeVisible();
    const worst = await page.evaluate(
      () => (window as unknown as { __frames: { worst: number } }).__frames.worst,
    );
    // No frame took a second: the work was not on the page's thread.
    expect(worst).toBeLessThan(1000);
  });

  test('cancels a merge', async ({ page, net }) => {
    const bytes = await makePdf(300);
    const files = [pdfSample('x.pdf', bytes), pdfSample('y.pdf', bytes)];
    net.watch(files[0]?.buffer ?? Buffer.alloc(0));
    await open(page);
    await upload(page, ...files);
    const merge = page.getByRole('button', { name: 'Merge', exact: true });
    await expect(merge).toBeEnabled();
    await merge.click();
    await page.getByRole('button', { name: 'Cancel' }).click();
    // Either the click came in time (cancelled) or the merge was already done: both leave a usable page.
    await expect(status(page)).toHaveText(/^(Merge cancelled\.|Merged 2 files)/);
    await expect(merge).toBeEnabled();
  });
});
