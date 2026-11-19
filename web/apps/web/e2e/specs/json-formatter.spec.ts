import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import { expectKeyboardOnly } from '../support/keyboard.ts';
import { expectNoHorizontalScroll } from '../support/reflow.ts';

// JSON formatter and validator in the built app, in Chromium and Firefox (T-23, #28). The
// accessibility gate (T-05, #13) applies to every tool: `a11y.check` after each state, a keyboard
// route for each action, results in live regions.

async function open(page: Page): Promise<void> {
  await page.goto('/tools/json-formatter');
  await expect(
    page.getByRole('heading', {
      level: 1,
      name: /^(JSON formatter and validator|JSON-Formatierer und -Prüfer)$/,
    }),
  ).toBeVisible();
}

function input(page: Page): ReturnType<Page['getByRole']> {
  return page.getByRole('textbox', { name: 'JSON', exact: true });
}

function result(page: Page): ReturnType<Page['getByRole']> {
  return page.getByRole('textbox', { name: 'Result', exact: true });
}

/** The tool's own polite status line (the first one on the page is the search count). */
function status(page: Page): ReturnType<Page['locator']> {
  return page.locator('main .tool-status:not(.alert)');
}

function alert(page: Page): ReturnType<Page['locator']> {
  return page.locator('main .tool-status.alert');
}

test.describe('json-formatter', () => {
  test('opens with one heading, formats the example and passes the accessibility gate', async ({
    page,
    a11y,
  }) => {
    await open(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(result(page)).toHaveValue(/^\{\n {2}"name": "stuffcloud"/);
    await expect(status(page)).toHaveText('Valid JSON. 9 values, nested 3 deep.');
    await a11y.check(page, 'json-formatter');
  });

  test('can be used with the keyboard alone', async ({ page }) => {
    await open(page);
    await expect(result(page)).toBeVisible();
    await expectKeyboardOnly(page, 'json-formatter');
  });

  test('formats, minifies and sorts, with the keyboard', async ({ page, a11y }) => {
    await open(page);
    await input(page).fill('{"b":[1,2],"a":{"d":1,"c":2}}');
    await page.getByRole('combobox', { name: 'Layout' }).selectOption('min');
    await expect(result(page)).toHaveValue('{"b":[1,2],"a":{"d":1,"c":2}}');
    const sort = page.getByRole('checkbox', { name: 'Sort the keys' });
    await sort.focus();
    await page.keyboard.press('Space');
    await expect(result(page)).toHaveValue('{"a":{"c":2,"d":1},"b":[1,2]}');
    await a11y.check(page, 'json-formatter: minified and sorted');
  });

  test('says where the JSON is wrong, in a live alert, and goes to the error', async ({
    page,
    a11y,
  }) => {
    await open(page);
    await input(page).fill('{\n  "a": 1\n  "b": 2\n}');
    await expect(alert(page)).toHaveText(
      'Unexpected “"”. Expected a comma or the closing brace. (line 3, column 3)',
    );
    await expect(result(page)).toHaveCount(0);
    await expect(alert(page)).toHaveAttribute('role', 'alert');
    await a11y.check(page, 'json-formatter: error');
    const go = page.getByRole('button', { name: 'Go to the error' });
    await go.focus();
    await page.keyboard.press('Enter');
    await expect(input(page)).toBeFocused();
    const caret = await input(page).evaluate((area: HTMLTextAreaElement) => area.selectionStart);
    expect(caret).toBe(13);
  });

  test('reads comments and JSON5, says so, and refuses them in strict mode', async ({
    page,
    a11y,
  }) => {
    await open(page);
    await input(page).fill("// note\n{a: 'x', b: [1,],}");
    await expect(result(page)).toHaveValue('{\n  "a": "x",\n  "b": [\n    1\n  ]\n}');
    await expect(status(page)).toContainText('Valid, but not strict JSON');
    await a11y.check(page, 'json-formatter: JSON5');
    await page.getByRole('checkbox', { name: 'Strict JSON only (no comments, no JSON5)' }).check();
    await expect(alert(page)).toHaveText('Strict JSON does not allow comments. (line 1, column 1)');
    await a11y.check(page, 'json-formatter: strict error');
  });

  test('shows the path at the cursor and finds a value by its path', async ({ page, a11y }) => {
    await open(page);
    await input(page).fill('{"a":[10,{"b c":true}]}');
    await input(page).evaluate((area: HTMLTextAreaElement) => {
      area.focus();
      area.setSelectionRange(area.value.indexOf('true'), area.value.indexOf('true'));
    });
    await page.keyboard.press('ArrowRight');
    await expect(page.getByText('Path at the cursor: $.a[1]["b c"]')).toBeVisible();
    const path = page.getByRole('textbox', { name: 'Find a value by its path' });
    await path.fill('$.a[1]');
    await expect(page.getByRole('textbox', { name: 'Value at this path' })).toHaveValue(
      '{\n  "b c": true\n}',
    );
    await a11y.check(page, 'json-formatter: path found');
    await path.fill('$.x');
    await expect(page.getByText('There is no value at this path.')).toBeVisible();
    await path.fill('$.a[');
    await expect(path).toHaveAttribute('aria-invalid', 'true');
    await a11y.check(page, 'json-formatter: path invalid');
  });

  test('warns about duplicate keys and keeps long numbers as written', async ({ page, a11y }) => {
    await open(page);
    await input(page).fill('{"a":1,"a":2,"n":12345678901234567890}');
    await expect(result(page)).toHaveValue(/"n": 12345678901234567890/);
    await expect(page.getByText(/1 key appears twice in the same object/)).toBeVisible();
    await expect(page.getByText(/1 number has more digits than a JavaScript number/)).toBeVisible();
    await a11y.check(page, 'json-formatter: warnings');
  });

  test('uses the result as the input and offers a download', async ({ page }) => {
    await open(page);
    await input(page).fill('{"a":1}');
    await page.getByRole('button', { name: 'Use the result as the input' }).click();
    await expect(input(page)).toHaveValue('{\n  "a": 1\n}');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download result' }).click();
    expect((await download).suggestedFilename()).toBe('formatted.json');
  });

  test('fits in 320 pixels without a horizontal scroll bar', async ({ page, a11y }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await open(page);
    await expect(result(page)).toBeVisible();
    await expectNoHorizontalScroll(page);
    await a11y.check(page, 'json-formatter: phone');
  });
});

test.describe('json-formatter in German', () => {
  test.use({ locale: 'de-DE' });

  test('shows the German texts and passes the gate', async ({ page, a11y }) => {
    await open(page);
    await expect(
      page.getByRole('heading', { level: 1, name: 'JSON-Formatierer und -Prüfer' }),
    ).toBeVisible();
    await expect(status(page)).toHaveText('Gültiges JSON. 9 Werte, 3 Ebenen tief.');
    await input(page).fill('[1,');
    await expect(alert(page)).toHaveText(
      'Der Text endet zu früh. Erwartet wurde ein Wert. (Zeile 1, Spalte 4)',
    );
    await a11y.check(page, 'json-formatter: German');
  });
});
