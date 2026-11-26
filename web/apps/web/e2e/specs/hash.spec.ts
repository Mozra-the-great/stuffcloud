import { createHash } from 'node:crypto';
import type { Page } from '@playwright/test';
import { sampleFile } from '../support/files.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectKeyboardOnly } from '../support/keyboard.ts';
import { expectNoHorizontalScroll } from '../support/reflow.ts';

// Hash and checksum in the built app, in Chromium and Firefox (T-22, #27). The accessibility gate
// (T-05, #13) applies to every tool: `a11y.check` after each state, a keyboard route for each
// action, results in live regions. A chosen file is registered with `net.watch`, so the privacy
// check (SPEC 14) fails the test if a piece of it is sent anywhere.

async function open(page: Page): Promise<void> {
  await page.goto('/tools/hash');
  await expect(
    page.getByRole('heading', { level: 1, name: /^(Hash and checksum|Hash und Prüfsumme)$/ }),
  ).toBeVisible();
}

function sha256(page: Page): ReturnType<Page['locator']> {
  return page.locator('.digest', { hasText: 'SHA-256' }).locator('.value');
}

/** The tool's own polite status line (the first one on the page is the search count). */
function status(page: Page): ReturnType<Page['locator']> {
  return page.locator('main [data-tool-status][role="status"]');
}

test.describe('hash', () => {
  test('opens with one heading and passes the accessibility gate', async ({ page, a11y }) => {
    await open(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(sha256(page)).toHaveText(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    await a11y.check(page, 'hash');
  });

  test('can be used with the keyboard alone', async ({ page }) => {
    await open(page);
    await expectKeyboardOnly(page, 'hash');
  });

  test('hashes what is typed, and announces it when the field is left', async ({ page, a11y }) => {
    await open(page);
    const field = page.getByRole('textbox', { name: 'Text to hash' });
    await field.fill('abc');
    await expect(sha256(page)).toHaveText(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    await expect(page.locator('.digest', { hasText: 'SHA-1' }).locator('.value')).toHaveText(
      'a9993e364706816aba3e25717850c26c9cd0d89d',
    );
    await a11y.check(page, 'hash: text');
    await page.keyboard.press('Tab');
    await expect(status(page)).toHaveText('The digests of the text are ready.');
  });

  test('shows the digests as upper case hex and as Base64', async ({ page, a11y }) => {
    await open(page);
    await page.getByRole('textbox', { name: 'Text to hash' }).fill('abc');
    await expect(sha256(page)).toHaveText(/^ba7816bf/);
    await page.getByRole('combobox', { name: 'Show as' }).selectOption('hex-upper');
    await expect(sha256(page)).toHaveText(/^BA7816BF/);
    await page.getByRole('combobox', { name: 'Show as' }).selectOption('base64');
    await expect(sha256(page)).toHaveText('ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=');
    await a11y.check(page, 'hash: base64');
  });

  test('compares with a checksum and says which algorithm matches', async ({ page, a11y }) => {
    await open(page);
    await page.getByRole('textbox', { name: 'Text to hash' }).fill('abc');
    const expected = page.getByRole('textbox', { name: 'Checksum you were given' });
    await expected.fill('BA7816BF 8F01CFEA 414140DE 5DAE2223 B00361A3 96177A9C B410FF61 F20015AD');
    await expect(page.getByText('It matches SHA-256.')).toBeVisible();
    await a11y.check(page, 'hash: match');
    await expected.press('Tab');
    await expect(status(page)).toHaveText('It matches SHA-256.');
    await expected.fill('ab'.repeat(32));
    await expect(page.getByText('It does not match any digest above.')).toBeVisible();
    await a11y.check(page, 'hash: no match');
    await expected.fill('not a digest');
    await expect(expected).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText(/This is not a hex digest/)).toBeVisible();
    await a11y.check(page, 'hash: invalid checksum');
  });

  test('hashes a file of several pieces in a worker, with the keyboard, and sends none of it', async ({
    page,
    net,
    a11y,
  }) => {
    const file = sampleFile('noise.bin', 5 * 1024 * 1024 + 17, 0x1234abcd);
    net.watch(file.buffer);
    await open(page);
    await page.getByRole('combobox', { name: 'Hash a' }).selectOption('file');
    await a11y.check(page, 'hash: file mode');
    const button = page.getByRole('button', { name: 'Choose a file' });
    await button.focus();
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('Enter');
    await (await chooser).setFiles(file);
    await expect(sha256(page)).toHaveText(createHash('sha256').update(file.buffer).digest('hex'), {
      timeout: 60_000,
    });
    await expect(page.locator('.digest', { hasText: 'SHA-512' }).locator('.value')).toHaveText(
      createHash('sha512').update(file.buffer).digest('hex'),
    );
    await expect(status(page)).toHaveText('The digests of noise.bin are ready.');
    await expect(
      page.getByText(`File: noise.bin, ${(5 * 1024 * 1024 + 17).toLocaleString('en')} bytes`),
    ).toBeVisible();
    await expect(page.getByRole('progressbar')).toHaveCount(0);
    await a11y.check(page, 'hash: file done');
  });

  test('fits in 320 pixels without a horizontal scroll bar', async ({ page, a11y }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await open(page);
    await page.getByRole('textbox', { name: 'Text to hash' }).fill('abc');
    await expect(sha256(page)).toHaveText(/^ba7816bf/);
    await expectNoHorizontalScroll(page);
    await a11y.check(page, 'hash: phone');
  });
});

test.describe('hash in German', () => {
  test.use({ locale: 'de-DE' });

  test('shows the German texts and passes the gate', async ({ page, a11y }) => {
    await open(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Hash und Prüfsumme' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Text zum Hashen' }).fill('abc');
    await expect(sha256(page)).toHaveText(/^ba7816bf/);
    await page.getByRole('textbox', { name: 'Vorgegebene Prüfsumme' }).fill('ab'.repeat(32));
    await expect(page.getByText('Er passt zu keinem der Hashes oben.')).toBeVisible();
    await a11y.check(page, 'hash: German');
  });
});
