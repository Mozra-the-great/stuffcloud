import type { Page } from '@playwright/test';
import { sampleFile } from '../support/files.ts';
import { expect, test } from '../support/fixtures.ts';
import { expectKeyboardOnly } from '../support/keyboard.ts';
import { expectNoHorizontalScroll } from '../support/reflow.ts';

// Base64 encoder and decoder in the built app, in Chromium and Firefox (T-17, #22). The
// accessibility gate (T-05, #13) applies to every tool: `a11y.check` after each state, a keyboard
// route for each action, results in live regions. A chosen file is registered with `net.watch`,
// so the privacy check (SPEC 14) fails the test if a piece of it is sent anywhere.

async function open(page: Page): Promise<void> {
  await page.goto('/tools/base64');
  await expect(
    page.getByRole('heading', {
      level: 1,
      name: /^(Base64 encoder and decoder|Base64-Kodierer und -Dekodierer)$/,
    }),
  ).toBeVisible();
}

function result(page: Page): ReturnType<Page['getByRole']> {
  return page.getByRole('textbox', { name: 'Result', exact: true });
}

/** The tool's own polite status line (the first one on the page is the search count). */
function status(page: Page): ReturnType<Page['locator']> {
  return page.locator('main [data-tool-status][role="status"]');
}

function alert(page: Page): ReturnType<Page['locator']> {
  return page.locator('main [data-tool-status][role="alert"]');
}

test.describe('base64', () => {
  test('opens with one heading, encodes the example and passes the accessibility gate', async ({
    page,
    a11y,
  }) => {
    await open(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(result(page)).toHaveValue('SGVsbG8sIHN0dWZmY2xvdWQh');
    await expect(status(page)).toHaveText('Encoded 18 bytes into 24 characters.');
    await a11y.check(page, 'base64');
  });

  test('can be used with the keyboard alone', async ({ page }) => {
    await open(page);
    await expect(result(page)).toBeVisible();
    await expectKeyboardOnly(page, 'base64');
  });

  test('encodes text as UTF-8 with the options, each one set with the keyboard', async ({
    page,
    a11y,
  }) => {
    await open(page);
    await page.getByRole('textbox', { name: 'Text to encode' }).fill('ä€😀>>');
    await expect(result(page)).toHaveValue(Buffer.from('ä€😀>>').toString('base64'));
    const urlSafe = page.getByRole('checkbox', { name: /^URL-safe alphabet/ });
    await urlSafe.focus();
    await page.keyboard.press('Space');
    await expect(result(page)).toHaveValue(`${Buffer.from('ä€😀>>').toString('base64url')}=`);
    const padding = page.getByRole('checkbox', { name: 'Add = padding' });
    await padding.focus();
    await page.keyboard.press('Space');
    await expect(result(page)).toHaveValue(Buffer.from('ä€😀>>').toString('base64url'));
    await page.getByRole('textbox', { name: 'Text to encode' }).fill('x'.repeat(100));
    await page.getByRole('combobox', { name: 'Line breaks' }).selectOption('76');
    await expect(result(page)).toHaveValue(/^.{76}\n.{58}$/);
    await a11y.check(page, 'base64: options');
  });

  test('writes a data URI and checks the media type', async ({ page, a11y }) => {
    await open(page);
    await page.getByRole('textbox', { name: 'Text to encode' }).fill('hi?>');
    await page.getByRole('checkbox', { name: /^Write as a data URI/ }).check();
    await expect(result(page)).toHaveValue('data:text/plain;charset=utf-8;base64,aGk/Pg==');
    await a11y.check(page, 'base64: data URI');
    const type = page.getByRole('textbox', { name: 'Media type of the data URI' });
    await type.fill('not a type');
    await expect(type).toHaveAttribute('aria-invalid', 'true');
    await expect(
      page.getByText('This is not a valid media type, such as text/plain.'),
    ).toBeVisible();
    await a11y.check(page, 'base64: media type invalid');
  });

  test('decodes text, and says where the Base64 is wrong', async ({ page, a11y }) => {
    await open(page);
    await page.getByRole('combobox', { name: 'Direction' }).selectOption('decode');
    const field = page.getByRole('textbox', { name: 'Base64 to decode' });
    await field.fill('SGVsbG8s\nIHN0dWZm Y2xvdWQh');
    await expect(page.getByRole('textbox', { name: 'Decoded text' })).toHaveValue(
      'Hello, stuffcloud!',
    );
    await expect(status(page)).toHaveText('Decoded 18 bytes as text.');
    await a11y.check(page, 'base64: decoded');
    await field.fill('SGVs\nbG!v');
    await expect(alert(page)).toHaveText('“!” is not a Base64 character. (line 2, column 3)');
    await expect(page.getByRole('textbox', { name: 'Decoded text' })).toHaveCount(0);
    await a11y.check(page, 'base64: decode error');
    await field.fill('-__-');
    await expect(page.getByText(/This is not text \(it is not valid UTF-8\)/)).toBeVisible();
    await a11y.check(page, 'base64: binary');
  });

  test('decodes a data URI to a downloadable file', async ({ page }) => {
    await open(page);
    await page.getByRole('combobox', { name: 'Direction' }).selectOption('decode');
    await page
      .getByRole('textbox', { name: 'Base64 to decode' })
      .fill('data:image/png;base64,iVBORw0KGgo=');
    await expect(page.getByText('The data URI says the type is image/png.')).toBeVisible();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download the decoded file' }).click();
    expect((await download).suggestedFilename()).toBe('decoded.png');
  });

  test('encodes a file of several pieces in a worker, with the keyboard, and sends none of it', async ({
    page,
    net,
    a11y,
  }) => {
    const file = sampleFile('noise.bin', 7 * 1024 * 1024 + 5, 0x5eed1234);
    net.watch(file.buffer);
    await open(page);
    await page.getByRole('combobox', { name: 'Source' }).selectOption('file');
    await a11y.check(page, 'base64: file mode');
    const button = page.getByRole('button', { name: 'Choose a file' });
    await button.focus();
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('Enter');
    await (await chooser).setFiles(file);
    await expect(status(page)).toHaveText(/^Encoded 7,340,037 bytes into 9,786,716 characters\.$/, {
      timeout: 60_000,
    });
    // The result is shown in part; what is copied is all of it.
    await expect(result(page)).toHaveValue(file.buffer.toString('base64').slice(0, 20_000));
    await expect(page.getByText(/Showing the first 20,000 of 9,786,716 characters/)).toBeVisible();
    await expect(page.getByRole('progressbar')).toHaveCount(0);
    await a11y.check(page, 'base64: file encoded');
  });

  test('decodes a file of Base64 text', async ({ page, a11y }) => {
    await open(page);
    await page.getByRole('combobox', { name: 'Direction' }).selectOption('decode');
    await page.getByRole('combobox', { name: 'Source' }).selectOption('file');
    await page.locator('input[type="file"]').setInputFiles({
      name: 'b64.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('aGVsbG8gd29ybGQ='),
    });
    await expect(page.getByRole('textbox', { name: 'Decoded text' })).toHaveValue('hello world');
    await expect(status(page)).toHaveText('Decoded 11 bytes as text.');
    await a11y.check(page, 'base64: file decoded');
  });

  test('fits in 320 pixels without a horizontal scroll bar', async ({ page, a11y }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await open(page);
    await expect(result(page)).toBeVisible();
    await expectNoHorizontalScroll(page);
    await a11y.check(page, 'base64: phone');
  });
});

test.describe('base64 in German', () => {
  test.use({ locale: 'de-DE' });

  test('shows the German texts and passes the gate', async ({ page, a11y }) => {
    await open(page);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Base64-Kodierer und -Dekodierer' }),
    ).toBeVisible();
    await expect(status(page)).toHaveText('18 Bytes in 24 Zeichen kodiert.');
    await page.getByRole('combobox', { name: 'Richtung' }).selectOption('decode');
    await page.getByRole('textbox', { name: 'Zu dekodierendes Base64' }).fill('ab!d');
    await expect(alert(page)).toHaveText('“!” ist kein Base64-Zeichen. (Zeile 1, Spalte 3)');
    await a11y.check(page, 'base64: German');
  });
});
