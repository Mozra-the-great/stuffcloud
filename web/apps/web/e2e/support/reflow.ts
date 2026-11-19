import { expect, type Page } from '@playwright/test';

/**
 * WCAG 1.4.10 (reflow): at 320 CSS pixels the page needs no horizontal scroll bar. On a failure the message
 * names the elements that stick out.
 */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
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
}
