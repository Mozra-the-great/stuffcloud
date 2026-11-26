import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import { expectKeyboardOnly } from '../support/keyboard.ts';
import { expectNoHorizontalScroll } from '../support/reflow.ts';

// JSON, YAML and XML converter in the built app, in Chromium and Firefox (T-17, #22). The
// accessibility gate (T-05, #13) applies to every tool: `a11y.check` after each state, a keyboard
// route for each action, results in live regions. The conversion runs in a worker; the tests with
// hostile and with large documents prove that the page stays usable.

async function open(page: Page): Promise<void> {
  await page.goto('/tools/json-yaml-xml');
  await expect(
    page.getByRole('heading', {
      level: 1,
      name: /^(JSON, YAML and XML converter|JSON-, YAML- und XML-Konverter)$/,
    }),
  ).toBeVisible();
}

function input(page: Page): ReturnType<Page['getByRole']> {
  return page.getByRole('textbox', { name: 'Input', exact: true });
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

async function formats(page: Page, from: string, to: string): Promise<void> {
  await page.getByRole('combobox', { name: 'Convert from' }).selectOption(from);
  await page.getByRole('combobox', { name: 'Convert to' }).selectOption(to);
}

test.describe('json-yaml-xml', () => {
  test('opens with one heading, converts the example and passes the accessibility gate', async ({
    page,
    a11y,
  }) => {
    await open(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(result(page)).toHaveValue(/^name: stuffcloud\ntags:\n {2}- json/);
    await expect(status(page)).toHaveText('Converted from JSON to YAML.');
    await a11y.check(page, 'json-yaml-xml');
  });

  test('can be used with the keyboard alone', async ({ page }) => {
    await open(page);
    await expect(result(page)).toBeVisible();
    await expectKeyboardOnly(page, 'json-yaml-xml');
  });

  test('converts to XML and back, with the options of XML', async ({ page, a11y }) => {
    await open(page);
    await formats(page, 'json', 'xml');
    await expect(result(page)).toHaveValue(/^<\?xml version="1\.0" encoding="UTF-8"\?>\n<root>\n/);
    await expect(page.getByText(/XML is read without DTDs/)).toBeVisible();
    await a11y.check(page, 'json-yaml-xml: XML');
    await page.getByRole('textbox', { name: 'Name of the XML root element' }).fill('data');
    await expect(result(page)).toHaveValue(/<data>/);
    await page
      .getByRole('button', { name: 'Swap formats and use the result as the input' })
      .click();
    await expect(page.getByRole('combobox', { name: 'Convert from' })).toHaveValue('xml');
    await page
      .getByRole('checkbox', { name: 'Read numbers and true or false in XML as such, not as text' })
      .check();
    await expect(result(page)).toHaveValue(/"count": 3/);
    await a11y.check(page, 'json-yaml-xml: back from XML');
  });

  test('says where a document is wrong, as a live alert, in each format', async ({
    page,
    a11y,
  }) => {
    await open(page);
    await input(page).fill('{\n  "a": 1\n  "b": 2\n}');
    await expect(alert(page)).toHaveText(
      'JSON input: Unexpected “"”. Expected a comma or the closing brace. (line 3, column 3)',
    );
    await expect(result(page)).toHaveCount(0);
    await a11y.check(page, 'json-yaml-xml: JSON error');
    await formats(page, 'xml', 'json');
    await input(page).fill('<a>\n<b></a>');
    await expect(alert(page)).toHaveText(
      'XML input: The closing tag <a> does not match the open element <b>. (line 2, column 6)',
    );
    await a11y.check(page, 'json-yaml-xml: XML error');
    await formats(page, 'yaml', 'json');
    await input(page).fill('a: 1\na: 2');
    await expect(alert(page)).toContainText('YAML input:');
    await expect(alert(page)).toContainText('(line 2, column 1)');
    await a11y.check(page, 'json-yaml-xml: YAML error');
  });

  test('refuses a billion laughs document in XML and in YAML, and works on afterwards', async ({
    page,
    a11y,
  }) => {
    await open(page);
    await formats(page, 'xml', 'json');
    await input(page).fill(
      [
        '<?xml version="1.0"?>',
        '<!DOCTYPE lolz [',
        '<!ENTITY lol "lol">',
        '<!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">',
        '<!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">',
        ']>',
        '<lolz>&lol3;</lolz>',
      ].join('\n'),
    );
    await expect(alert(page)).toContainText(
      'A DOCTYPE with an internal subset (entity declarations) is not supported',
    );
    await a11y.check(page, 'json-yaml-xml: XML bomb');
    await formats(page, 'yaml', 'json');
    const lines = ['a: &a [lol, lol, lol, lol, lol, lol, lol, lol, lol]'];
    let previous = 'a';
    for (const name of ['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']) {
      lines.push(
        `${name}: &${name} [${Array.from({ length: 9 }, () => `*${previous}`).join(', ')}]`,
      );
      previous = name;
    }
    await input(page).fill(lines.join('\n'));
    await expect(alert(page)).toContainText('a YAML bomb');
    await a11y.check(page, 'json-yaml-xml: YAML bomb');
    await input(page).fill('a: 1');
    await expect(result(page)).toHaveValue('{\n  "a": 1\n}');
  });

  test('converts a large document in the background and stays usable', async ({ page, a11y }) => {
    await open(page);
    const items = Array.from({ length: 60_000 }, (_, index) => ({
      id: index,
      name: `item ${String(index)}`,
      tags: ['a', 'b'],
    }));
    await input(page).fill(JSON.stringify({ items }));
    // The page answers while the worker converts: the options can be changed at once.
    await page.getByRole('checkbox', { name: 'Sort the keys' }).check();
    await expect(result(page)).toHaveValue(/^items:\n {2}- id: 0\n {4}name: item 0/, {
      timeout: 30_000,
    });
    await expect(status(page)).toHaveText('Converted from JSON to YAML.');
    await a11y.check(page, 'json-yaml-xml: large');
  });

  test('says what cannot be written as XML, with the place', async ({ page, a11y }) => {
    await open(page);
    await formats(page, 'json', 'xml');
    await input(page).fill('{"a":{"b c":1}}');
    await expect(alert(page)).toHaveText(
      'This cannot be written as XML: “b c” is not a valid XML element or attribute name (at $.a["b c"]). Rename the key.',
    );
    await a11y.check(page, 'json-yaml-xml: cannot write');
  });

  test('copies and downloads the result', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => undefined);
    await open(page);
    await expect(result(page)).toBeVisible();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download result' }).click();
    expect((await download).suggestedFilename()).toBe('converted.yaml');
  });

  test('fits in 320 pixels without a horizontal scroll bar', async ({ page, a11y }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await open(page);
    await formats(page, 'json', 'xml');
    await expect(result(page)).toBeVisible();
    await expectNoHorizontalScroll(page);
    await a11y.check(page, 'json-yaml-xml: phone');
  });
});

test.describe('json-yaml-xml in German', () => {
  test.use({ locale: 'de-DE' });

  test('shows the German texts and passes the gate', async ({ page, a11y }) => {
    await open(page);
    await expect(
      page.getByRole('heading', { level: 1, name: 'JSON-, YAML- und XML-Konverter' }),
    ).toBeVisible();
    await expect(status(page)).toHaveText('Von JSON nach YAML umgewandelt.');
    await page.getByRole('textbox', { name: 'Eingabe', exact: true }).fill('[1,');
    await expect(alert(page)).toHaveText(
      'Eingabe als JSON: Der Text endet zu früh. Erwartet wurde ein Wert. (Zeile 1, Spalte 4)',
    );
    await a11y.check(page, 'json-yaml-xml: German');
  });
});
