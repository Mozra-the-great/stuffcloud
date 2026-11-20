import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import { expectKeyboardOnly } from '../support/keyboard.ts';
import { expectNoHorizontalScroll } from '../support/reflow.ts';

// MAC address tool in the built app, in Chromium and Firefox (T-20, #25). The accessibility gate
// (T-05, #13) applies to every tool: `a11y.check` after each state, a keyboard route for each
// action, results in live regions. The vendor lists are made up for the test (no IEEE data is in the
// repository); a chosen list is registered with `net.watch`, so the privacy check (SPEC 14) fails the
// test if a piece of it is sent anywhere.

const HEADER = 'Registry,Assignment,Organization Name,Organization Address';

/** A vendor list in the layout of the IEEE files, with invented names. */
function vendorList(): { name: string; mimeType: string; buffer: Buffer } {
  const rows = [
    HEADER,
    'MA-L,00A0B0,Example Networks Ltd,"1 Example Street\nSampletown"',
    'MA-L,04D5E6,"Sample ""Quoted"" Devices, Inc.",Somewhere',
    '',
  ];
  return {
    name: 'oui.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(rows.join('\r\n'), 'utf8'),
  };
}

async function open(page: Page): Promise<void> {
  await page.goto('/tools/mac');
  await expect(
    page.getByRole('heading', { level: 1, name: /^(MAC address|MAC-Adresse)$/ }),
  ).toBeVisible();
}

function input(page: Page): ReturnType<Page['getByRole']> {
  return page.getByRole('textbox', { name: /^(MAC addresses|MAC-Adressen)$/ });
}

/** The tool's own polite status line (the first one on the page is the search count). */
function status(page: Page): ReturnType<Page['locator']> {
  return page.locator('main .tool-status:not(.alert)');
}

function alert(page: Page): ReturnType<Page['locator']> {
  return page.locator('main .tool-status.alert');
}

function value(page: Page, label: string): ReturnType<Page['locator']> {
  return page
    .getByRole('row', { name: new RegExp(`^${label.replace(/[()^]/g, String.raw`\$&`)}`) })
    .getByRole('cell')
    .first();
}

test.describe('mac', () => {
  test('opens with one heading and passes the accessibility gate', async ({ page, a11y }) => {
    await open(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(value(page, 'Dash, upper case')).toHaveText('00-00-5E-00-53-01');
    await expect(value(page, 'Transmission')).toHaveText('Unicast');
    await a11y.check(page, 'mac');
  });

  test('can be used with the keyboard alone', async ({ page }) => {
    await open(page);
    await expectKeyboardOnly(page, 'mac');
  });

  test('reads another spelling, shows the bits, and announces them when the field is left', async ({
    page,
    a11y,
  }) => {
    await open(page);
    await input(page).fill('02-1A-2B-3C-4D-5E');
    await expect(value(page, 'Colon, lower case')).toHaveText('02:1a:2b:3c:4d:5e');
    await expect(value(page, 'Administration')).toHaveText('Local');
    await expect(value(page, 'OUI prefix')).toHaveText('02-1A-2B');
    await a11y.check(page, 'mac: locally administered');
    await input(page).press('Tab');
    await expect(status(page)).toHaveText('02:1a:2b:3c:4d:5e: Unicast, Local.');
    await input(page).fill('01:00:5e:00:00:fb');
    await expect(value(page, 'Transmission')).toHaveText('Multicast');
    await expect(page.getByText(/multicast address of an IPv4 multicast group/)).toBeVisible();
    await a11y.check(page, 'mac: multicast');
    await input(page).fill('ff:ff:ff:ff:ff:ff');
    await expect(value(page, 'Transmission')).toHaveText('Broadcast');
    await input(page).fill('34:56:78:ff:fe:9a:bc:de');
    await expect(value(page, 'Kind')).toHaveText('EUI-64');
    await a11y.check(page, 'mac: EUI-64');
  });

  test('says what is wrong, in the field and in the live region', async ({ page, a11y }) => {
    await open(page);
    await input(page).fill('00:1a:2b:3c:4d');
    await expect(input(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText(/12 hexadecimal digits/).first()).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
    await input(page).press('Tab');
    await expect(status(page)).toContainText('12 hexadecimal digits');
    await a11y.check(page, 'mac: invalid');
  });

  test('lists several addresses, with the reason for the ones that cannot be read', async ({
    page,
    a11y,
  }) => {
    await open(page);
    await input(page).fill('00:00:5e:00:53:01\nnot a mac\n01:00:5e:00:00:fb\n0200.5e00.5302');
    await expect(page.getByRole('row', { name: /not a mac/ })).toContainText('only the digits');
    await expect(page.getByRole('row', { name: /0200\.5e00\.5302/ })).toContainText('Local');
    await input(page).press('Tab');
    await expect(status(page)).toHaveText('3 of 4 addresses are valid.');
    await a11y.check(page, 'mac: list');
  });

  test('copies a spelling and confirms it, with the keyboard', async ({
    page,
    context,
    browserName,
    a11y,
  }) => {
    if (browserName === 'chromium') {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    }
    await open(page);
    await page.getByRole('button', { name: 'Copy Dots (Cisco)' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('region', { name: 'Notifications' })).toContainText(
      'Copied 0000.5e00.5301',
    );
    if (browserName === 'chromium') {
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('0000.5e00.5301');
    }
    await a11y.check(page, 'mac: copied');
  });

  test('shows vendor names only from a list the visitor chooses, and sends none of it', async ({
    page,
    net,
    a11y,
  }) => {
    const list = vendorList();
    net.watch(list.buffer);
    await open(page);
    await input(page).fill('00:a0:b0:12:34:56');
    await expect(value(page, 'Vendor')).toHaveText(/No vendor list loaded/);
    await expect(page.getByRole('link', { name: /standards\.ieee\.org/ })).toHaveAttribute(
      'href',
      /^https:\/\/standards\.ieee\.org\//,
    );
    await a11y.check(page, 'mac: before a list is loaded');
    const button = page.getByRole('button', { name: 'Choose IEEE CSV files' });
    await button.focus();
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('Enter');
    await (await chooser).setFiles(list);
    await expect(status(page)).toHaveText('Vendor list loaded: 2 entries. It stays in this tab.');
    await expect(value(page, 'Vendor')).toHaveText('Example Networks Ltd (MA-L 00A0B0)');
    await expect(page.getByRole('listitem').filter({ hasText: 'oui.csv' })).toHaveText(
      'oui.csv: entries read: 2',
    );
    await a11y.check(page, 'mac: list loaded');
    await input(page).fill('00:a0:b0:00:00:01\n04:d5:e6:00:00:02\n02:00:00:00:00:03');
    await expect(page.getByRole('columnheader', { name: 'Vendor' })).toBeVisible();
    await expect(page.getByRole('row', { name: /04:d5:e6:00:00:02/ })).toContainText(
      'Sample "Quoted" Devices, Inc. (MA-L 04D5E6)',
    );
    await expect(page.getByRole('row', { name: /02:00:00:00:00:03/ })).toContainText(
      'locally administered',
    );
    await a11y.check(page, 'mac: vendors in the list');
    await page.getByRole('button', { name: 'Remove the vendor list' }).focus();
    await page.keyboard.press('Enter');
    await expect(status(page)).toHaveText('The vendor list was removed.');
    await expect(page.getByRole('columnheader', { name: 'Vendor' })).toHaveCount(0);
    await a11y.check(page, 'mac: list removed');
  });

  test('says which file is not a vendor list', async ({ page, net, a11y }) => {
    const notes = {
      name: 'notes.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('name,count\nsome notes about nothing,7\n', 'utf8'),
    };
    net.watch(notes.buffer);
    await open(page);
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Choose IEEE CSV files' }).click();
    await (await chooser).setFiles(notes);
    await expect(alert(page)).toHaveText(/^notes\.csv is not an IEEE vendor list/);
    await a11y.check(page, 'mac: wrong file');
  });

  test('fits in 320 pixels without a horizontal scroll bar', async ({ page, net, a11y }) => {
    const list = vendorList();
    net.watch(list.buffer);
    await page.setViewportSize({ width: 320, height: 640 });
    await open(page);
    await expect(page.getByRole('table')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await a11y.check(page, 'mac: phone, details');
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Choose IEEE CSV files' }).click();
    await (await chooser).setFiles(list);
    await expect(status(page)).toContainText('Vendor list loaded');
    await input(page).fill('00:a0:b0:00:00:01\n04:d5:e6:00:00:02\nzz');
    await expect(page.getByRole('columnheader', { name: 'Vendor' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await a11y.check(page, 'mac: phone, list');
  });
});

test.describe('mac in German', () => {
  test.use({ locale: 'de-DE' });

  test('shows the German texts and passes the gate', async ({ page, a11y }) => {
    await page.goto('/tools/mac');
    await expect(page.getByRole('heading', { level: 1, name: 'MAC-Adresse' })).toBeVisible();
    await expect(value(page, 'Übertragung')).toHaveText('Unicast');
    await expect(value(page, 'Verwaltung')).toHaveText('Universell');
    await expect(
      page.getByRole('heading', { level: 2, name: 'Herstellernamen (optional)' }),
    ).toBeVisible();
    await a11y.check(page, 'mac: German');
    await input(page).fill('00:1a:2b:3c:4d');
    await expect(page.getByText(/12 Hexadezimalziffern/).first()).toBeVisible();
    await a11y.check(page, 'mac: German error');
  });
});
