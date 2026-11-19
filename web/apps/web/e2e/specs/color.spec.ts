import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import { expectKeyboardOnly } from '../support/keyboard.ts';
import { png } from '../support/png.ts';

// Colour picker in the built app, in Chromium and Firefox (T-18, #23). The accessibility gate
// (T-05, #13) applies to every tool: `a11y.check` after each state, a keyboard route for each action,
// results in live regions. The picture for the palette is generated here and registered with
// `net.watch`, so the privacy check (SPEC 14) fails the test if a piece of it is sent anywhere.

async function open(page: Page): Promise<void> {
  await page.goto('/tools/color');
  await expect(
    page.getByRole('heading', { level: 1, name: /^(Colour picker|Farbwähler)$/ }),
  ).toBeVisible();
}

/** The value of a format in the list of formats. */
function format(page: Page, name: string): ReturnType<Page['locator']> {
  return page.locator('.formats li', { hasText: name }).locator('code');
}

/** The polite status line of the tool (the toast region has its own). */
function status(page: Page): ReturnType<Page['locator']> {
  return page.locator('.tool-status:not(.alert)');
}

// 20 x 20 pixels: three quarters red, one quarter blue; no scaling, so the colours stay exact.
const PICTURE = png(20, 20, (x) => (x < 15 ? [200, 30, 30] : [20, 40, 220]));

test.describe('color', () => {
  test('opens with one heading and passes the accessibility gate', async ({ page, a11y }) => {
    await open(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1, name: 'Colour picker' })).toBeVisible();
    await expect(format(page, 'HEX')).toHaveText('#3a7bd5');
    await a11y.check(page, 'color');
  });

  test('can be used with the keyboard alone', async ({ page }) => {
    await open(page);
    await expectKeyboardOnly(page, 'color');
  });

  test('shows a typed colour in every format, announces it and passes the gate', async ({
    page,
    a11y,
  }) => {
    await open(page);
    const field = page.getByRole('textbox', { name: 'Colour', exact: true });
    await field.fill('hsl(120, 100%, 50%)');
    await expect(format(page, 'HEX')).toHaveText('#00ff00');
    await expect(format(page, 'RGB')).toHaveText('rgb(0, 255, 0)');
    await expect(format(page, 'OKLCH')).toHaveText(/^oklch\(/);
    await expect(format(page, 'CMYK')).toHaveText('cmyk(100%, 0%, 100%, 0%)');
    await a11y.check(page, 'color: typed colour');
    // Enter is the keyboard route to "done": the result is announced.
    await field.press('Enter');
    await expect(status(page)).toHaveText('Colour set to #00ff00');
    await a11y.check(page, 'color: announced');
  });

  test('says what is wrong with a text that is no colour, and keeps the last colour', async ({
    page,
    a11y,
  }) => {
    await open(page);
    const field = page.getByRole('textbox', { name: 'Colour', exact: true });
    await field.fill('rgb(300, 0, 0)');
    await expect(page.getByText('A value is outside its range.')).toBeVisible();
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await expect(format(page, 'HEX')).toHaveText('#3a7bd5');
    await a11y.check(page, 'color: invalid colour');
    await field.press('Enter');
    await expect(status(page)).toHaveText('A value is outside its range.');
    await field.fill('#fff');
    await expect(field).not.toHaveAttribute('aria-invalid', 'true');
    await expect(format(page, 'HEX')).toHaveText('#ffffff');
  });

  test('moves an OKLCH colour into the sRGB range and says so', async ({ page, a11y }) => {
    await open(page);
    await page.getByRole('textbox', { name: 'Colour', exact: true }).fill('oklch(70% 0.4 150)');
    await expect(page.getByText(/outside the sRGB range/)).toBeVisible();
    await a11y.check(page, 'color: out of gamut');
  });

  test('checks the contrast of two colours, passing and failing', async ({ page, a11y }) => {
    await open(page);
    await page.getByRole('textbox', { name: 'Text colour', exact: true }).fill('#000000');
    await page.getByRole('textbox', { name: 'Background colour', exact: true }).fill('#ffffff');
    await expect(page.getByText('Contrast ratio 21:1', { exact: true })).toBeVisible();
    const aa = page.getByRole('row', { name: /^AA, normal text/ });
    await expect(aa).toContainText('Pass');
    await a11y.check(page, 'color: contrast passes');

    await page.getByRole('textbox', { name: 'Text colour', exact: true }).fill('#777777');
    await expect(page.getByText('Contrast ratio 4.47:1', { exact: true })).toBeVisible();
    await expect(aa).toContainText('Fail');
    await expect(page.getByRole('row', { name: /^AA, large text/ })).toContainText('Pass');
    await page.getByRole('textbox', { name: 'Text colour', exact: true }).press('Enter');
    await expect(status(page)).toContainText('Normal text AA: Fail');
    await a11y.check(page, 'color: contrast fails');
  });

  test('uses the colour above for the contrast check, with buttons', async ({ page }) => {
    await open(page);
    await page
      .getByRole('button', { name: 'Use the colour above as background colour' })
      .press('Enter');
    await expect(page.getByRole('textbox', { name: 'Background colour', exact: true })).toHaveValue(
      '#3a7bd5',
    );
    await page.getByRole('button', { name: 'Swap colours' }).press('Enter');
    await expect(page.getByRole('textbox', { name: 'Text colour', exact: true })).toHaveValue(
      '#3a7bd5',
    );
    await expect(page.getByRole('textbox', { name: 'Background colour', exact: true })).toHaveValue(
      '#1f2937',
    );
  });

  test('copies a format with the keyboard and confirms it', async ({
    page,
    context,
    browserName,
    a11y,
  }) => {
    if (browserName === 'chromium') {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    }
    await open(page);
    const copy = page.getByRole('button', { name: 'Copy RGB' });
    await copy.focus();
    await page.keyboard.press('Enter');
    const toasts = page.getByRole('region', { name: 'Notifications' });
    await expect(toasts).toContainText('Copied rgb(58, 123, 213)');
    if (browserName === 'chromium') {
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('rgb(58, 123, 213)');
    }
    await a11y.check(page, 'color: copied');
  });

  test('takes the colours of an image and uses one of them', async ({ page, net, a11y }) => {
    net.watch(PICTURE);
    await open(page);
    await page
      .locator('input[type="file"]')
      .setInputFiles({ name: 'flag.png', mimeType: 'image/png', buffer: PICTURE });
    const list = page.getByRole('list', { name: 'Colours of flag.png' });
    await expect(list.locator('code')).toHaveText(['#c81e1e', '#1428dc']);
    await expect(list).toContainText('75 % of the image');
    await expect(status(page)).toHaveText('Palette ready: 2 colours from flag.png');
    await a11y.check(page, 'color: palette');

    const use = page.getByRole('button', { name: 'Use #1428dc as the colour' });
    await use.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('textbox', { name: 'Colour', exact: true })).toHaveValue('#1428dc');
    await expect(format(page, 'RGB')).toHaveText('rgb(20, 40, 220)');
  });

  test('chooses an image with the keyboard and follows the number of colours', async ({
    page,
    net,
  }) => {
    net.watch(PICTURE);
    await open(page);
    const choose = page.getByRole('button', { name: 'Choose an image' });
    await choose.focus();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.keyboard.press('Enter'),
    ]);
    await chooser.setFiles({ name: 'flag.png', mimeType: 'image/png', buffer: PICTURE });
    const list = page.getByRole('list', { name: 'Colours of flag.png' });
    await expect(list.locator('code')).toHaveCount(2);
    // One colour: the median cut has nothing left to cut.
    const count = page.getByRole('spinbutton', { name: 'Number of colours' });
    await count.fill('2');
    await expect(list.locator('code')).toHaveCount(2);
    await count.fill('12');
    await expect(list.locator('code')).toHaveCount(2);
  });

  test('reports a file that is not an image, and one without visible pixels', async ({
    page,
    a11y,
  }) => {
    await open(page);
    const input = page.locator('input[type="file"]');
    await input.setInputFiles({
      name: 'notes.png',
      mimeType: 'image/png',
      buffer: Buffer.from('not a picture'),
    });
    const problem = page.locator('.tool-status.alert');
    await expect(problem).toHaveText('This file could not be read as an image.');
    await a11y.check(page, 'color: unreadable image');

    const clear = png(4, 4, () => [0, 0, 0, 0]);
    await input.setInputFiles({ name: 'clear.png', mimeType: 'image/png', buffer: clear });
    await expect(problem).toHaveText('This image has no visible pixels.');
    await a11y.check(page, 'color: empty image');
  });

  test('fits in 320 pixels without a horizontal scroll bar', async ({ page, a11y }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await open(page);
    await page
      .locator('input[type="file"]')
      .setInputFiles({ name: 'flag.png', mimeType: 'image/png', buffer: PICTURE });
    await expect(page.getByRole('list', { name: 'Colours of flag.png' })).toBeVisible();
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
    await a11y.check(page, 'color: phone');
  });
});

test.describe('color in German', () => {
  test.use({ locale: 'de-DE' });

  test('shows the German texts and passes the gate', async ({ page, a11y }) => {
    await open(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Farbwähler' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Kontrast' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'HEX kopieren' })).toBeVisible();
    await a11y.check(page, 'color: German');
  });
});
