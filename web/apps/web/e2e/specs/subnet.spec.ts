import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import { expectKeyboardOnly } from '../support/keyboard.ts';
import { expectNoHorizontalScroll } from '../support/reflow.ts';

// Subnet calculator in the built app, in Chromium and Firefox (T-20, #25). The accessibility gate
// (T-05, #13) applies to every tool: `a11y.check` after each state, a keyboard route for each
// action, results in live regions.

type Mode = 'split' | 'summary' | 'contains';

const MODE_LABELS: Readonly<Record<Mode, string>> = {
  split: 'Split into subnets',
  summary: 'Summarise networks and ranges',
  contains: 'Is it inside?',
};

async function open(page: Page): Promise<void> {
  await page.goto('/tools/subnet');
  await expect(
    page.getByRole('heading', { level: 1, name: /^(Subnet calculator|Subnetz-Rechner)$/ }),
  ).toBeVisible();
}

async function choose(page: Page, mode: Mode): Promise<void> {
  await page.getByRole('combobox', { name: 'What to calculate' }).selectOption(MODE_LABELS[mode]);
}

/** The tool's own polite status line (the first one on the page is the search count). */
function status(page: Page): ReturnType<Page['locator']> {
  return page.locator('main [data-tool-status]');
}

function value(page: Page, label: string): ReturnType<Page['locator']> {
  return page
    .getByRole('row', { name: new RegExp(`^${label.replace(/[()^]/g, String.raw`\$&`)}`) })
    .getByRole('cell')
    .first();
}

test.describe('subnet', () => {
  test('opens with one heading and passes the accessibility gate', async ({ page, a11y }) => {
    await open(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(value(page, 'Netmask')).toHaveText('255.255.255.0');
    await expect(value(page, 'Usable addresses')).toHaveText('254');
    await a11y.check(page, 'subnet');
  });

  test('can be used with the keyboard alone', async ({ page }) => {
    await open(page);
    await expectKeyboardOnly(page, 'subnet');
  });

  test('describes a network, and announces it when the field is left', async ({ page, a11y }) => {
    await open(page);
    const field = page.getByRole('textbox', { name: 'IP address or network' });
    await field.fill('198.51.100.77/26');
    await expect(value(page, 'Network (CIDR)')).toHaveText('198.51.100.64/26');
    await expect(value(page, 'Broadcast address')).toHaveText('198.51.100.127');
    await expect(page.getByText(/host bits set/)).toBeVisible();
    await a11y.check(page, 'subnet: host bits');
    await field.press('Tab');
    await expect(status(page)).toHaveText(
      '198.51.100.64/26: 198.51.100.65 to 198.51.100.126, 62 usable.',
    );
  });

  test('describes the edge cases: /31, /32 and IPv6', async ({ page, a11y }) => {
    await open(page);
    const field = page.getByRole('textbox', { name: 'IP address or network' });
    await field.fill('192.0.2.2/31');
    await expect(value(page, 'Broadcast address')).toHaveText('none');
    await expect(page.getByText(/RFC 3021/)).toBeVisible();
    await a11y.check(page, 'subnet: /31');
    await field.fill('192.0.2.9/32');
    await expect(value(page, 'Addresses')).toHaveText('1');
    await field.fill('2001:db8::/64');
    await expect(value(page, 'Addresses')).toHaveText('18,446,744,073,709,551,616 (2^64)');
    await expect(value(page, 'Last address')).toHaveText('2001:db8::ffff:ffff:ffff:ffff');
    await a11y.check(page, 'subnet: IPv6');
    await field.fill('2001:db8::2/127');
    await expect(page.getByText(/RFC 6164/)).toBeVisible();
    await field.fill('::ffff:192.0.2.0/120');
    await expect(value(page, 'IPv4 form')).toHaveText('192.0.2.0/24');
    await a11y.check(page, 'subnet: mapped');
  });

  test('says what is wrong with the input, in the field and in the live region', async ({
    page,
    a11y,
  }) => {
    await open(page);
    const field = page.getByRole('textbox', { name: 'IP address or network' });
    await field.fill('192.0.2.0/33');
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText(/prefix length is a whole number/).first()).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
    await field.press('Tab');
    await expect(status(page)).toContainText('prefix length is a whole number');
    await a11y.check(page, 'subnet: invalid');
  });

  test('splits a network into subnets, by number and by prefix length', async ({ page, a11y }) => {
    await open(page);
    await choose(page, 'split');
    await expect(page.locator('main .lead')).toHaveText('4 subnets with prefix length /26.');
    await expect(page.getByRole('row', { name: /192\.0\.2\.192\/26/ })).toBeVisible();
    await a11y.check(page, 'subnet: split');
    await page.getByRole('combobox', { name: 'Split by' }).selectOption('prefix');
    const prefix = page.getByRole('textbox', { name: 'New prefix length' });
    await expect(prefix).toHaveValue('26');
    await prefix.fill('25');
    await prefix.press('Tab');
    await expect(status(page)).toHaveText('2 subnets with prefix length /25.');
    await a11y.check(page, 'subnet: split by prefix');
    await prefix.fill('7');
    await expect(prefix).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText('The prefix length must be from 24 to 32.').first()).toBeVisible();
    await a11y.check(page, 'subnet: split error');
  });

  test('summarises networks and ranges, per IP version', async ({ page, a11y }) => {
    await open(page);
    await choose(page, 'summary');
    await expect(page.getByRole('listitem').filter({ hasText: '192.0.2.0/24' })).toBeVisible();
    await a11y.check(page, 'subnet: summary');
    const list = page.getByRole('textbox', { name: 'Networks, addresses and ranges' });
    await list.fill(
      '198.51.100.1-198.51.100.6\n198.51.100.0\n198.51.100.7\n2001:db8::/33\n2001:db8:8000::/33',
    );
    await expect(page.getByRole('heading', { level: 3 })).toHaveText(['IPv4', 'IPv6']);
    await expect(page.getByRole('listitem').filter({ hasText: /^2001:db8::\/32$/ })).toBeVisible();
    await list.press('Tab');
    await expect(status(page)).toHaveText('Summarised to 2 networks.');
    await a11y.check(page, 'subnet: summary of two versions');
    await list.fill('192.0.2.0/24\n192.0.2.300');
    await expect(
      page.getByText('Line 2: Each number of an IPv4 address is from 0 to 255.').first(),
    ).toBeVisible();
    await a11y.check(page, 'subnet: summary error');
  });

  test('checks whether an address or network is inside another', async ({ page, a11y }) => {
    await open(page);
    await choose(page, 'contains');
    await expect(page.locator('main .lead')).toHaveText('192.0.2.77 is inside 192.0.2.0/24.');
    await a11y.check(page, 'subnet: contains');
    const other = page.getByRole('textbox', { name: 'Address or network to check' });
    await other.fill('::ffff:192.0.3.1');
    await expect(page.locator('main .lead')).toContainText('is not inside 192.0.2.0/24.');
    await expect(page.locator('main .lead')).toContainText('IPv4-mapped form');
    await other.press('Tab');
    await expect(status(page)).toContainText('::ffff:192.0.3.1 is not inside 192.0.2.0/24.');
    await a11y.check(page, 'subnet: mapped');
  });

  test('copies a value and confirms it, with the keyboard', async ({
    page,
    context,
    browserName,
    a11y,
  }) => {
    if (browserName === 'chromium') {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    }
    await open(page);
    await page.getByRole('button', { name: 'Copy Netmask' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('region', { name: 'Notifications' })).toContainText(
      'Copied 255.255.255.0',
    );
    if (browserName === 'chromium') {
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('255.255.255.0');
    }
    await a11y.check(page, 'subnet: copied');
  });

  test('fits in 320 pixels without a horizontal scroll bar', async ({ page, a11y }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await open(page);
    await page.getByRole('textbox', { name: 'IP address or network' }).fill('2001:db8:1:2::/64');
    await expect(value(page, 'Last address')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await a11y.check(page, 'subnet: phone, details');
    await choose(page, 'split');
    await page.getByRole('textbox', { name: 'Network to split' }).fill('2001:db8::/62');
    await expect(page.getByRole('row', { name: /2001:db8:0:3::\/64/ })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await a11y.check(page, 'subnet: phone, split');
    await choose(page, 'summary');
    await expect(page.getByRole('table')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await a11y.check(page, 'subnet: phone, summary');
  });
});

test.describe('subnet in German', () => {
  test.use({ locale: 'de-DE' });

  test('shows the German texts and numbers, and passes the gate', async ({ page, a11y }) => {
    await page.goto('/tools/subnet');
    await expect(page.getByRole('heading', { level: 1, name: 'Subnetz-Rechner' })).toBeVisible();
    await expect(value(page, 'Netzmaske')).toHaveText('255.255.255.0');
    await page.getByRole('textbox', { name: 'IP-Adresse oder Netz' }).fill('0.0.0.0/0');
    await expect(value(page, 'Adressen')).toHaveText('4.294.967.296 (2^32)');
    await a11y.check(page, 'subnet: German');
    await page.getByRole('textbox', { name: 'IP-Adresse oder Netz' }).fill('1.2.3');
    await expect(page.getByText(/Eine IPv4-Adresse besteht aus vier Zahlen/).first()).toBeVisible();
    await a11y.check(page, 'subnet: German error');
  });
});
