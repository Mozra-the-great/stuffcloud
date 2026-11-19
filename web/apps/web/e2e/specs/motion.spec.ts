import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';

// prefers-reduced-motion (WCAG 2.3.3, SPEC 12, ADR 0008): with the setting on, nothing on screen
// moves: no running CSS animation, no transition that takes time, no smooth scrolling. The same
// pages with the setting off do move, which proves the test can fail.

/** Everything that animates in the document right now, by animation name. */
async function runningAnimations(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    document
      .getAnimations()
      .filter((animation) => animation.playState === 'running')
      .map((animation) =>
        animation instanceof CSSAnimation
          ? `animation ${animation.animationName}`
          : animation instanceof CSSTransition
            ? `transition ${animation.transitionProperty}`
            : 'script animation',
      ),
  );
}

/** Computed motion of every element: animation names and transition times other than none/0s. */
async function declaredMotion(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const found: string[] = [];
    for (const element of document.querySelectorAll('*')) {
      const style = getComputedStyle(element);
      const tag = element.tagName.toLowerCase();
      if (style.animationName !== 'none') {
        found.push(`${tag}: animation ${style.animationName}`);
      }
      if (style.transitionDuration.split(',').some((time) => Number.parseFloat(time) > 0)) {
        found.push(`${tag}: transition ${style.transitionDuration}`);
      }
      if (style.scrollBehavior === 'smooth') {
        found.push(`${tag}: smooth scroll`);
      }
    }
    return found;
  });
}

/** Svelte scopes keyframe names (`svelte-1fgzk1b-bob`): the idle bob of the mascots, by its end. */
async function bobbing(page: Page): Promise<boolean> {
  return (await runningAnimations(page)).some((name) => name.endsWith('-bob'));
}

const PAGES: readonly { path: string; heading: string }[] = [
  { path: '/', heading: 'Your stuff, in your cloud.' },
  { path: '/tools', heading: 'Tools' },
  { path: '/nowhere', heading: 'Nothing here' },
  { path: '/tools/worker-lab', heading: 'Worker lab' },
  { path: '/gallery.html', heading: 'Components' },
];

test.describe('with prefers-reduced-motion: reduce', () => {
  test.use({ reducedMotion: 'reduce' });

  for (const { path, heading } of PAGES) {
    test(`${path} has no animation and no timed transition`, async ({ page, a11y }) => {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
      expect(
        await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
      ).toBe(true);
      expect(await runningAnimations(page), 'running animations').toEqual([]);
      expect(await declaredMotion(page), 'animation, transition or smooth scroll declared').toEqual(
        [],
      );
      await a11y.check(page, `${path} with reduced motion`);
    });
  }

  test('the mascots show their still pose', async ({ page }) => {
    await page.goto('/gallery.html');
    const images = page.locator('[data-mascot] img');
    await expect(images.first()).toBeVisible();
    expect(await images.count()).toBeGreaterThan(5);
    const styles = await images.evaluateAll((elements) =>
      elements.map((element) => {
        const style = getComputedStyle(element);
        return { animation: style.animationName, transform: style.transform };
      }),
    );
    for (const style of styles) {
      expect(style).toEqual({ animation: 'none', transform: 'none' });
    }
  });

  test('the indeterminate progress bar stands still', async ({ page }) => {
    await page.goto('/gallery.html');
    const bar = page.getByRole('progressbar', { name: 'Working' });
    await expect(bar).toBeVisible();
    expect(await bar.evaluate((element) => element.getAnimations({ subtree: true }).length)).toBe(
      0,
    );
  });

  test('a toast and a dialog appear without any animation', async ({ page }) => {
    await page.goto('/gallery.html');
    await page.getByRole('button', { name: 'info', exact: true }).click();
    await expect(page.getByText('A info message')).toBeVisible();
    await page.getByRole('button', { name: 'Open dialog' }).click();
    await expect(page.getByRole('dialog', { name: 'Delete site' })).toBeVisible();
    expect(await runningAnimations(page), 'running animations').toEqual([]);
  });

  test('a page change does not scroll smoothly', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.getByRole('link', { name: 'Open the tools' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Tools' })).toBeFocused();
    expect(
      await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior),
    ).toBe('auto');
    expect(await runningAnimations(page)).toEqual([]);
  });
});

test.describe('with the setting off the same pages move (the test can fail)', () => {
  test.use({ reducedMotion: 'no-preference' });

  test('the gallery runs the mascot animation', async ({ page }) => {
    await page.goto('/gallery.html');
    await expect(page.getByRole('heading', { level: 1, name: 'Components' })).toBeVisible();
    await expect.poll(() => bobbing(page)).toBe(true);
    expect((await declaredMotion(page)).some((line) => line.endsWith('-bob'))).toBe(true);
  });

  test('the home page mascot bobs', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect.poll(() => bobbing(page)).toBe(true);
  });
});

test.describe('switching the setting while the page is open', () => {
  test('the animations stop and start without a reload', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect.poll(() => bobbing(page)).toBe(true);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(() => runningAnimations(page)).toEqual([]);

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect.poll(() => bobbing(page)).toBe(true);
  });
});
