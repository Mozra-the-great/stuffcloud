import { attachScreenshot, expect, test } from '../support/fixtures.ts';

// The app shell of T-03 in a real browser: navigation, focus, announcements, 404, language,
// search and the phone menu. Chromium and Firefox run the same file.

test.describe('navigation', () => {
  test('the first load shows the home page and leaves focus alone', async ({ page, a11y }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your stuff, in your cloud.');
    await expect(page).toHaveTitle('Your stuff, in your cloud. · stuffcloud');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    // Focus moves after a navigation, not when the page loads (a screen reader reads the page).
    await expect(page.getByRole('heading', { level: 1 })).not.toBeFocused();
    await a11y.check(page, 'home');
  });

  test('a link click moves focus to the h1, sets the title and announces the page', async ({
    page,
    a11y,
  }) => {
    await page.goto('/');
    // The live region is in the page, empty, before any text is put into it.
    await expect(page.locator('[role="status"][aria-live="polite"]:empty')).toBeAttached();
    await page.evaluate(() => {
      document.documentElement.dataset['e2eMarker'] = 'same document';
    });

    await page.getByRole('link', { name: 'Open the tools' }).click();

    await expect(page.getByRole('heading', { level: 1, name: 'Tools' })).toBeFocused();
    await expect(page).toHaveTitle('Tools · stuffcloud');
    await expect(page).toHaveURL('/tools');
    await expect(
      page.locator('[role="status"][aria-live="polite"]', { hasText: 'Navigated to Tools' }),
    ).toHaveText('Navigated to Tools');
    // No page load: the marker set before the click is still there.
    await expect(page.locator('html')).toHaveAttribute('data-e2e-marker', 'same document');
    await a11y.check(page, 'tools');
  });

  test('back and forward restore the pages and move focus to the h1', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Open the tools' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Tools' })).toBeFocused();

    await page.goBack();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your stuff, in your cloud.');
    await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
    await expect(page).toHaveURL('/');

    await page.goForward();
    await expect(page.getByRole('heading', { level: 1, name: 'Tools' })).toBeFocused();
  });

  test('a deep link opens the page directly with one h1', async ({ page }) => {
    await page.goto('/tools');
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tools');
    await expect(page).toHaveTitle('Tools · stuffcloud');
  });

  test('the skip link moves focus to the main content', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('main')).toBeFocused();
  });
});

test.describe('not found', () => {
  test('an unknown address shows the 404 page, with a way home', async ({ page, a11y }) => {
    await page.goto('/this/is/not/a/page');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Nothing here');
    await expect(page).toHaveTitle('Nothing here · stuffcloud');
    await a11y.check(page, 'not found');

    await page.getByRole('link', { name: 'Go to stuffcloud' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your stuff, in your cloud.');
    await expect(page).toHaveURL('/');
  });

  test('an unknown tool id is a 404 too', async ({ page }) => {
    await page.goto('/tools/no-such-tool');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Nothing here');
  });
});

test.describe('language', () => {
  test('switches to German without a reload and remembers the choice', async ({ page }) => {
    await page.goto('/tools');
    await page.evaluate(() => {
      document.documentElement.dataset['e2eMarker'] = 'same document';
    });
    const group = page.getByRole('group', { name: 'Language' });
    await expect(group.getByRole('button', { name: 'English' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await group.getByRole('button', { name: 'Deutsch' }).click();

    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tools');
    await expect(page.getByRole('link', { name: 'Zum Inhalt springen' })).toBeAttached();
    await expect(page.getByRole('group', { name: 'Sprache' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Deutsch' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.locator('html')).toHaveAttribute('data-e2e-marker', 'same document');

    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Deine Sachen in deiner Cloud.',
    );
    await expect(page).toHaveTitle('Deine Sachen in deiner Cloud. · stuffcloud');
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  });

  test('the title follows the language on the same page', async ({ page }) => {
    await page.goto('/this-is-not-a-page');
    await expect(page).toHaveTitle('Nothing here · stuffcloud');
    await page.getByRole('button', { name: 'Deutsch' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Hier ist nichts');
    await expect(page).toHaveTitle('Hier ist nichts · stuffcloud');
  });

  test('a German browser starts in German', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ locale: 'de-DE', baseURL: baseURL ?? '' });
    try {
      const page = await context.newPage();
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        'Deine Sachen in deiner Cloud.',
      );
      await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    } finally {
      await context.close();
    }
  });
});

test.describe('search', () => {
  test('Ctrl+K opens the search dialog, which takes focus', async ({ page, a11y }) => {
    await page.goto('/');
    await page.keyboard.press('Control+K');
    const dialog = page.getByRole('dialog', { name: 'Search tools' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('searchbox', { name: 'Search' })).toBeFocused();
    await a11y.check(page, 'search dialog');
  });

  test('Meta+K opens it too (Cmd+K on a Mac)', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Meta+K');
    await expect(page.getByRole('dialog', { name: 'Search tools' })).toBeVisible();
  });

  test('a plain K does not open it, Escape closes it and returns focus', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('k');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    const opener = page.getByRole('button', { name: /^Search tools/ });
    await opener.focus();
    await page.keyboard.press('Control+K');
    await expect(page.getByRole('dialog', { name: 'Search tools' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(opener).toBeFocused();
  });

  test('the button opens it and a query with no hit says so', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /^Search tools/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Search tools' });
    await dialog.getByRole('searchbox', { name: 'Search' }).fill('zzz-nothing-like-it');
    await expect(dialog.getByRole('status')).toHaveText('No tools found');
  });
});

test.describe('phone menu', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the links are behind a menu button that opens, closes and follows a navigation', async ({
    page,
    a11y,
  }) => {
    await page.goto('/');
    const header = page.locator('header');
    const toggle = header.getByRole('button', { name: 'Open menu' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(header.getByRole('link', { name: 'Tools' })).toBeHidden();

    await toggle.click();
    await expect(header.getByRole('button', { name: 'Close menu' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(header.getByRole('link', { name: 'Tools' })).toBeVisible();
    await a11y.check(page, 'phone menu open');

    await page.keyboard.press('Escape');
    await expect(header.getByRole('button', { name: 'Open menu' })).toBeFocused();
    await expect(header.getByRole('link', { name: 'Tools' })).toBeHidden();

    await header.getByRole('button', { name: 'Open menu' }).click();
    await header.getByRole('link', { name: 'Tools' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Tools' })).toBeFocused();
    // The menu belongs to one page: after the navigation it is closed again.
    await expect(header.getByRole('button', { name: 'Open menu' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  test('the language switch works from the menu', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.getByRole('button', { name: 'Deutsch' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Deine Sachen in deiner Cloud.',
    );
  });
});

test.describe('smoke screenshots', () => {
  // Pictures for people to look at in the CI report: they are attached, never compared with a
  // stored image, so a font hinting difference cannot turn the build red.
  const pages: readonly { name: string; path: string; heading: string }[] = [
    { name: 'home', path: '/', heading: 'Your stuff, in your cloud.' },
    { name: 'tools', path: '/tools', heading: 'Tools' },
    { name: 'not-found', path: '/nope', heading: 'Nothing here' },
  ];

  for (const entry of pages) {
    test(`the ${entry.name} page renders`, async ({ page }, testInfo) => {
      await page.goto(entry.path);
      await expect(page.getByRole('heading', { level: 1, name: entry.heading })).toBeVisible();
      await attachScreenshot(page, testInfo, `${entry.name}.png`);
    });
  }

  test('the home page renders on a phone', async ({ browser, baseURL }, testInfo) => {
    const context = await browser.newContext({
      baseURL: baseURL ?? '',
      viewport: { width: 390, height: 844 },
      reducedMotion: 'reduce',
      locale: 'en-US',
    });
    try {
      const page = await context.newPage();
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await attachScreenshot(page, testInfo, 'home-phone.png');
    } finally {
      await context.close();
    }
  });

  test('the component gallery renders', async ({ page }, testInfo) => {
    await page.goto('/gallery.html');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await attachScreenshot(page, testInfo, 'gallery.png');
  });
});

test.describe('design kit theme (ADR 0014)', () => {
  test('kern’s Code theme is on the root and keeps the design’s text metrics', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'code');
    await expect(page.locator('body')).not.toHaveAttribute('data-theme');
    const metrics = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const body = getComputedStyle(document.body);
      return {
        kernBg: body.getPropertyValue('--k-bg').trim(),
        background: body.backgroundColor,
        lineHeight: body.lineHeight,
        rootFontSize: root.fontSize,
      };
    });
    expect(metrics.kernBg).toBe('#101012');
    expect(metrics.background).toBe('rgb(16, 16, 18)');
    // The design sets no line height (kern#145) and the root keeps the reader's font size (kern#144).
    expect(metrics.lineHeight).toBe('normal');
    expect(metrics.rootFontSize).toBe('16px');
  });

  test('the root font size follows the reader’s default (no px size on <html>)', async ({
    page,
  }) => {
    await page.goto('/');
    const sizes = await page.evaluate(() => ({
      inline: document.documentElement.style.fontSize,
      rule: [...document.styleSheets]
        .flatMap((sheet) => [...sheet.cssRules])
        .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule)
        .filter((rule) =>
          rule.selectorText.split(',').some((s) => s.trim() === 'html' || s.trim() === ':root'),
        )
        .map((rule) => rule.style.fontSize)
        .filter((size) => size !== ''),
    }));
    expect(sizes).toEqual({ inline: '', rule: [] });
  });
});
