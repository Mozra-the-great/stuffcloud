import type { Locator } from '@playwright/test';
import { sampleFile } from '../support/files.ts';
import { expect, test } from '../support/fixtures.ts';
import {
  expectFocusStaysInDialog,
  expectKeyboardOnly,
  focusableNames,
  open,
} from '../support/keyboard.ts';

// The keyboard map of the app, as tests (T-05, #13; docs/ACCESSIBILITY.md has the map in words):
// every page can be walked with Tab alone in the order of the document, nothing traps focus, the
// focus is always visible and never hidden behind something, and every widget answers to the keys
// its WAI-ARIA pattern names. Chromium and Firefox run the same file.

test.describe('walking a page with Tab alone', () => {
  test('home: skip link first, then the header, then the content', async ({ page, a11y }) => {
    await open(page, '/', 'Your stuff, in your cloud.');
    const order = await expectKeyboardOnly(page, 'home');
    expect(order.slice(0, 2)).toEqual(['Skip to content', 'stuffcloud']);
    expect(order).toContain('Open the tools');
    await a11y.check(page, 'home after the keyboard walk');
  });

  test('tools: categories and tiles are all reachable', async ({ page }) => {
    await open(page, '/tools', 'Tools');
    const order = await expectKeyboardOnly(page, 'tools');
    expect(order).toEqual(expect.arrayContaining(['Skip to content', 'Text', 'Extras']));
    expect(order.some((name) => name.startsWith('Worker lab'))).toBe(true);
  });

  test('the 404 page keeps a way home', async ({ page }) => {
    await open(page, '/nowhere', 'Nothing here');
    const order = await expectKeyboardOnly(page, '404');
    expect(order).toContain('Go to stuffcloud');
  });

  test('the worker lab, a tool with a drop zone, buttons and a progress bar', async ({ page }) => {
    await open(page, '/tools/worker-lab', 'Worker lab');
    const order = await expectKeyboardOnly(page, 'worker lab');
    expect(order).toContain('Choose files');
    expect(order).toContain('Start a job that never ends');
    // Cancel and Download are disabled until there is something to cancel or download: a
    // disabled button is skipped, never a stop that does nothing.
    expect(order).not.toContain('Cancel');
    expect(order).not.toContain('Download report');
  });

  test('the component gallery', async ({ page }) => {
    await open(page, '/gallery.html', 'Components');
    await expectKeyboardOnly(page, 'gallery');
  });

  test('the phone layout: the menu button replaces the header links', async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({
      baseURL: baseURL ?? '',
      viewport: { width: 390, height: 844 },
      reducedMotion: 'reduce',
      locale: 'en-US',
    });
    try {
      const page = await context.newPage();
      await open(page, '/', 'Your stuff, in your cloud.');
      const closed = await expectKeyboardOnly(page, 'phone, menu closed');
      expect(closed).toContain('Open menu');
      expect(closed).not.toContain('Tools');

      await page.getByRole('button', { name: 'Open menu' }).click();
      const opened = await focusableNames(page);
      expect(opened).toEqual(expect.arrayContaining(['Close menu', 'Tools', 'English', 'Deutsch']));
    } finally {
      await context.close();
    }
  });
});

test.describe('the checks can fail', () => {
  test('a page that hides its focus ring is caught', async ({ page }) => {
    await open(page, '/', 'Your stuff, in your cloud.');
    await page.addStyleTag({
      content:
        '*:focus, *:focus-visible { outline: none !important; box-shadow: none !important; }',
    });
    await expect(expectKeyboardOnly(page, 'home without a ring')).rejects.toThrow(
      'shows its focus',
    );
  });

  test('a page whose focus is covered by something is caught', async ({ page }) => {
    await open(page, '/', 'Your stuff, in your cloud.');
    await page.evaluate(() => {
      const cover = document.createElement('div');
      cover.style.cssText = 'position: fixed; inset: 0; z-index: 1000;';
      document.body.append(cover);
    });
    await expect(expectKeyboardOnly(page, 'home with a cover')).rejects.toThrow(
      'is not covered when focused',
    );
  });
});

test.describe('the search dialog', () => {
  test('opens with Ctrl+K, keeps focus inside while Tab is pressed, closes with Escape', async ({
    page,
  }) => {
    await open(page, '/', 'Your stuff, in your cloud.');
    const opener = page.getByRole('button', { name: /^Search tools/ });
    await opener.focus();
    await page.keyboard.press('Control+K');
    const dialog = page.getByRole('dialog', { name: 'Search tools' });
    await expect(dialog.getByRole('searchbox', { name: 'Search' })).toBeFocused();

    // Tab and Shift+Tab walk around the dialog and never reach the page behind it.
    await expectFocusStaysInDialog(page);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  });

  test('a query and Enter open the first hit, and focus lands on the tool heading', async ({
    page,
  }) => {
    await open(page, '/', 'Your stuff, in your cloud.');
    await page.keyboard.press('Control+K');
    const box = page.getByRole('searchbox', { name: 'Search' });
    await expect(box).toBeFocused();
    await page.keyboard.type('worker');
    await expect(page.getByRole('status').filter({ hasText: /found|result|tool/i })).toBeAttached();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1, name: 'Worker lab' })).toBeFocused();
  });

  test('a hit can be chosen with Tab and Enter', async ({ page }) => {
    await open(page, '/', 'Your stuff, in your cloud.');
    await page.keyboard.press('Control+K');
    await page.keyboard.type('sample');
    const hit = page.getByRole('dialog').getByRole('link', { name: /Sample tool/ });
    await expect(hit).toBeVisible();
    await page.keyboard.press('Tab'); // the close button, then the first hit
    await hit.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1, name: 'Sample tool' })).toBeFocused();
  });
});

test.describe('the header and the menu', () => {
  test('the language switch works with Enter and Space and keeps its focus', async ({ page }) => {
    await open(page, '/tools', 'Tools');
    const deutsch = page.getByRole('button', { name: 'Deutsch' });
    await deutsch.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    await expect(page.getByRole('button', { name: 'Deutsch' })).toBeFocused();

    await page.getByRole('button', { name: 'English' }).focus();
    await page.keyboard.press('Space');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('button', { name: 'English' })).toBeFocused();
  });

  test('the phone menu opens with Enter, its links follow, Escape returns to the button', async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({
      baseURL: baseURL ?? '',
      viewport: { width: 390, height: 844 },
      reducedMotion: 'reduce',
      locale: 'en-US',
    });
    try {
      const page = await context.newPage();
      await open(page, '/', 'Your stuff, in your cloud.');
      const toggle = page.getByRole('button', { name: 'Open menu' });
      await toggle.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('button', { name: 'Close menu' })).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(page.locator('header').getByRole('link', { name: 'Tools' })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('button', { name: 'Open menu' })).toBeFocused();
      await expect(page.locator('header').getByRole('link', { name: 'Tools' })).toBeHidden();
    } finally {
      await context.close();
    }
  });
});

test.describe('components with their own keys', () => {
  test('tabs: one stop, arrows move the selection, Home and End jump, Tab leaves', async ({
    page,
  }) => {
    await open(page, '/gallery.html', 'Components');
    const tablist = page.getByRole('tablist', { name: 'Formats' });
    const tab = (name: string): Locator => tablist.getByRole('tab', { name });
    await tab('JSON').focus();
    await expect(tab('JSON')).toHaveAttribute('aria-selected', 'true');

    await page.keyboard.press('ArrowRight');
    await expect(tab('YAML')).toBeFocused();
    await expect(tab('YAML')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('End');
    await expect(tab('XML')).toBeFocused();
    await page.keyboard.press('ArrowRight'); // wraps
    await expect(tab('JSON')).toBeFocused();
    await page.keyboard.press('ArrowLeft'); // wraps back
    await expect(tab('XML')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(tab('JSON')).toBeFocused();

    // Roving tabindex: only the selected tab is a Tab stop, the next stop is its panel.
    await page.keyboard.press('Tab');
    await expect(page.getByRole('tabpanel')).toBeFocused();
  });

  test('a dialog opens from its button, traps Tab, closes with Escape and gives focus back', async ({
    page,
  }) => {
    await open(page, '/gallery.html', 'Components');
    const opener = page.getByRole('button', { name: 'Open dialog' });
    await opener.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Delete site' });
    await expect(dialog).toBeVisible();
    await expectFocusStaysInDialog(page);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();

    // The way out through a button works from the keyboard too.
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).focus();
    await page.keyboard.press('Space');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  });

  test('a toast is dismissed with the keyboard', async ({ page }) => {
    await open(page, '/gallery.html', 'Components');
    await page.getByRole('button', { name: 'warn', exact: true }).focus();
    await page.keyboard.press('Enter');
    const toast = page.getByText('A warn message');
    await expect(toast).toBeVisible();
    await page.getByRole('button', { name: 'Dismiss' }).focus();
    await page.keyboard.press('Enter');
    await expect(toast).toHaveCount(0);
  });

  test('the drop zone opens the file picker from the keyboard and takes the chosen file', async ({
    page,
  }) => {
    await open(page, '/gallery.html', 'Components');
    await page.getByRole('button', { name: 'Choose files' }).focus();
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('Enter');
    await (
      await chooser
    ).setFiles({
      name: 'paper.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4'),
    });
    await expect(page.locator('p[aria-live="polite"]')).toHaveText('paper.pdf');
  });
});

test.describe('a tool with the keyboard only', () => {
  test('choose a file, read the result, start a job, cancel it', async ({ page, net }) => {
    await open(page, '/tools/worker-lab', 'Worker lab');
    const file = sampleFile('keyboard.bin', 2048, 7);
    net.watch(file.buffer);

    await page.getByRole('button', { name: 'Choose files' }).focus();
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('Enter');
    await (await chooser).setFiles(file);
    await expect(page.getByTestId('lab-status')).toHaveAttribute('data-status', 'done');
    await expect(page.getByRole('list', { name: 'Digests' })).toContainText('keyboard.bin');

    // The next control in the tab order is the one that starts the job; Cancel is still disabled.
    await page.getByRole('button', { name: 'Choose files' }).focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Start a job that never ends' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('lab-status')).toHaveAttribute('data-status', 'working');

    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Space');
    await expect(page.getByTestId('lab-status')).toHaveAttribute('data-status', 'cancelled');
  });
});

test.describe('status updates reach assistive technology', () => {
  test('toasts: calm ones in a status region, errors in an alert, both present before use', async ({
    page,
  }) => {
    await open(page, '/gallery.html', 'Components');
    // Both regions exist, empty, before the first toast: a region added together with its text
    // is not announced by every screen reader.
    await expect(
      page.locator('section[aria-label="Notifications"] [role="status"]:empty'),
    ).toBeAttached();
    await expect(
      page.locator('section[aria-label="Notifications"] [role="alert"]:empty'),
    ).toBeAttached();

    await page.getByRole('button', { name: 'success', exact: true }).click();
    await expect(
      page.locator('section[aria-label="Notifications"] [role="status"]', {
        hasText: 'A success message',
      }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'error', exact: true }).click();
    await expect(
      page.locator('section[aria-label="Notifications"] [role="alert"]', {
        hasText: 'A error message',
      }),
    ).toBeVisible();
  });

  test('a progress bar says what it measures and how far it is', async ({ page }) => {
    await open(page, '/gallery.html', 'Components');
    const upload = page.getByRole('progressbar', { name: 'Upload' });
    await expect(upload).toHaveAttribute('aria-valuemin', '0');
    await expect(upload).toHaveAttribute('aria-valuemax', '100');
    await expect(upload).toHaveAttribute('aria-valuenow', '40');
    // Work of unknown length has no value, which a screen reader reads as "busy".
    const working = page.getByRole('progressbar', { name: 'Working' });
    await expect(working).not.toHaveAttribute('aria-valuenow', /.*/);
  });

  test('a page change is announced once in the polite live region, and the region is not removed', async ({
    page,
  }) => {
    await open(page, '/', 'Your stuff, in your cloud.');
    const region = page.locator('[role="status"][aria-live="polite"]');
    await expect(region).toHaveText('');
    await page.getByRole('link', { name: 'Open the tools' }).click();
    await expect(region).toHaveText('Navigated to Tools');
    await page.getByRole('link', { name: 'stuffcloud' }).first().click();
    await expect(region).toHaveText(/Navigated to/);
    await expect(region).toHaveCount(1);
  });
});
