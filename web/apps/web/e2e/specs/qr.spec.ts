import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { decodeQrPng } from '../support/decode-png.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectKeyboardOnly } from '../support/keyboard.ts';
import { expectNoHorizontalScroll } from '../support/reflow.ts';

// QR code generator in the built app, in Chromium and Firefox (T-21, #26). The accessibility gate
// (T-05, #13) applies to every tool: `a11y.check` after each state, a keyboard route for each action,
// results in live regions. The downloaded PNG is decoded by a reader in the test (`jsQR`, which shares
// no code with the encoder).

const TEXT = 'https://example.org/path?x=1&y=2 — grüße 😀';

async function open(page: Page): Promise<void> {
  await page.goto('/tools/qr');
  await expect(
    page.getByRole('heading', { level: 1, name: /^(QR code generator|QR-Code-Generator)$/ }),
  ).toBeVisible();
}

async function fillText(page: Page, value: string): Promise<void> {
  await page.getByRole('textbox', { name: /^(Text or URL|Text oder URL)$/ }).fill(value);
}

function picture(page: Page): ReturnType<Page['getByRole']> {
  return page.getByRole('img', { name: /^(QR code|QR-Code)\./ });
}

/** The tool's own polite status line and its alert (the first live region on the page is the search count). */
function status(page: Page): ReturnType<Page['locator']> {
  return page.locator('main [data-tool-status][role="status"]');
}

function alert(page: Page): ReturnType<Page['locator']> {
  return page.locator('main [data-tool-status][role="alert"]');
}

test.describe('qr', () => {
  test('opens with one heading, asks for content and passes the accessibility gate', async ({
    page,
    a11y,
  }) => {
    await open(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByText('Type a text or a link to see the code.')).toBeVisible();
    await expect(picture(page)).toHaveCount(0);
    await a11y.check(page, 'qr: empty');
  });

  test('can be used with the keyboard alone', async ({ page }) => {
    await open(page);
    await expectKeyboardOnly(page, 'qr');
  });

  test('shows the stuffcloud style with a text alternative and the content as text', async ({
    page,
    a11y,
  }) => {
    await open(page);
    await fillText(page, TEXT);
    const image = picture(page);
    await expect(image).toBeVisible();
    await expect(image).toHaveAttribute('alt', 'QR code. Its content is written below.');
    await expect(image).toHaveAttribute('aria-describedby', 'qr-content');
    await expect(page.locator('#qr-content')).toHaveText(TEXT);
    await expect(page.getByText(/Scan test passed/)).toBeVisible();
    await expect(status(page)).toHaveText('QR code ready. The scan test passed.');
    // The picture really loaded (a broken image has no width).
    expect(
      await image.evaluate((element: HTMLImageElement) => element.naturalWidth),
    ).toBeGreaterThan(0);
    await a11y.check(page, 'qr: stuffcloud style');
  });

  test('works with the keyboard from the text to the downloads', async ({ page, a11y }) => {
    await open(page);
    await page.getByRole('textbox', { name: 'Text or URL' }).focus();
    await page.keyboard.type('keyboard only');
    await expect(picture(page)).toBeVisible();
    await page.getByRole('button', { name: 'Download SVG' }).focus();
    const download = page.waitForEvent('download');
    await page.keyboard.press('Enter');
    expect((await download).suggestedFilename()).toBe('qr-code.svg');
    await expect(status(page)).toHaveText('Saved qr-code.svg.');
    await a11y.check(page, 'qr: SVG saved');
  });

  test('offers the raw style with a free choice of the level', async ({ page, a11y }) => {
    await open(page);
    await fillText(page, 'raw');
    await expect(picture(page)).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Error correction' })).toBeDisabled();
    await page.getByRole('combobox', { name: 'Style' }).selectOption('raw');
    await expect(page.getByRole('combobox', { name: 'Error correction' })).toBeEnabled();
    await page.getByRole('combobox', { name: 'Error correction' }).selectOption('L');
    await expect(picture(page)).toBeVisible();
    await a11y.check(page, 'qr: raw style');
  });

  for (const style of ['stuffcloud', 'raw']) {
    test(`downloads a PNG of the chosen size that a QR reader decodes (${style})`, async ({
      page,
    }) => {
      await open(page);
      await fillText(page, TEXT);
      await page.getByRole('combobox', { name: 'Style' }).selectOption(style);
      await page.getByRole('combobox', { name: 'Size of the PNG' }).selectOption('512');
      await expect(picture(page)).toBeVisible();
      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download PNG' }).click();
      const file = await download;
      expect(file.suggestedFilename()).toBe('qr-code.png');
      const path = await file.path();
      const decoded = decodeQrPng(await readFile(path));
      expect(decoded.width).toBe(512);
      expect(decoded.height).toBe(512);
      expect(decoded.text).toBe(TEXT);
      await expect(status(page)).toHaveText('Saved qr-code.png, 512 pixels.');
    });
  }

  test('downloads an SVG that has the picture of the page', async ({ page }) => {
    await open(page);
    await fillText(page, 'svg file');
    await expect(picture(page)).toBeVisible();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download SVG' }).click();
    const svg = await readFile(await (await download).path(), 'utf8');
    expect(svg.startsWith('<svg xmlns=')).toBe(true);
    expect(svg).toContain('viewBox="0 0 ');
    const source = await picture(page).evaluate(async (element: HTMLImageElement) => {
      const response = await fetch(element.src);
      return await response.text();
    });
    expect(svg).toBe(source);
  });

  test('makes a Wi-Fi code and a contact code and shows what they encode', async ({
    page,
    a11y,
  }) => {
    await open(page);
    await page.getByRole('combobox', { name: 'What to encode' }).selectOption('wifi');
    await expect(page.getByText('Enter the network name to see the code.')).toBeVisible();
    await a11y.check(page, 'qr: Wi-Fi, nothing yet');
    await page.getByRole('textbox', { name: 'Network name (SSID)' }).fill('Home');
    await page.getByRole('textbox', { name: 'Password' }).fill('secret123');
    await page.getByRole('checkbox', { name: 'The network is hidden' }).check();
    await expect(picture(page)).toBeVisible();
    await expect(page.locator('#qr-content')).toHaveText('WIFI:T:WPA;S:Home;P:secret123;H:true;;');
    await a11y.check(page, 'qr: Wi-Fi');

    await page.getByRole('combobox', { name: 'What to encode' }).selectOption('contact');
    await page.getByRole('textbox', { name: 'First name' }).fill('Ada');
    await page.getByRole('textbox', { name: 'Last name' }).fill('Lovelace');
    await page.getByRole('textbox', { name: 'E-mail' }).fill('ada@example.org');
    await expect(picture(page)).toBeVisible();
    await expect(page.locator('#qr-content')).toContainText('BEGIN:VCARD');
    await expect(page.locator('#qr-content')).toContainText('FN:Ada Lovelace');
    await a11y.check(page, 'qr: contact');
  });

  test('says when the content is too long, and offers no picture', async ({ page, a11y }) => {
    await open(page);
    await fillText(page, 'a'.repeat(3500));
    await expect(alert(page)).toHaveText('The content is too long for a QR code. Shorten it.');
    await expect(picture(page)).toHaveCount(0);
    await a11y.check(page, 'qr: too long');
  });

  test('falls back to the raw style when the text does not fit the stuffcloud style', async ({
    page,
    a11y,
  }) => {
    await open(page);
    await page.getByRole('combobox', { name: 'Style' }).selectOption('raw');
    await page.getByRole('combobox', { name: 'Error correction' }).selectOption('L');
    await page.getByRole('combobox', { name: 'Style' }).selectOption('stuffcloud');
    await fillText(page, 'b'.repeat(1500));
    await expect(status(page)).toHaveText(
      'The text is too long for the stuffcloud style (level H), so the raw style at your chosen level is shown.',
    );
    await expect(picture(page)).toBeVisible();
    await a11y.check(page, 'qr: fallback');
  });

  test('fits in 320 pixels without a horizontal scroll bar', async ({ page, a11y }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await open(page);
    await fillText(
      page,
      'https://example.org/a/very/long/address/that/has/no/spaces/at/all/and/goes/on',
    );
    await expect(picture(page)).toBeVisible();
    await expectNoHorizontalScroll(page);
    await a11y.check(page, 'qr: phone');
  });
});

test.describe('qr in German', () => {
  test.use({ locale: 'de-DE' });

  test('shows the German texts and passes the gate', async ({ page, a11y }) => {
    await open(page);
    await expect(page.getByRole('heading', { level: 1, name: 'QR-Code-Generator' })).toBeVisible();
    await fillText(page, 'Hallo Welt');
    await expect(picture(page)).toBeVisible();
    await expect(status(page)).toHaveText('QR-Code fertig. Der Scan-Test wurde bestanden.');
    await a11y.check(page, 'qr: German');
  });
});
