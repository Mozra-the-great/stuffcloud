import { expect, type Page } from '@playwright/test';

// Keyboard helpers shared by the specs (T-05, #13). A tool's spec calls `expectKeyboardOnly` to
// show that every control of the tool can be reached with Tab alone, in document order, with a
// visible focus that nothing covers.

export interface Stop {
  readonly name: string;
  readonly visibleFocus: boolean;
  readonly obscured: boolean;
}

/** The elements a keyboard user reaches with Tab on the page as it is now, in document order. */
export async function focusableNames(page: Page, scope = 'body'): Promise<string[]> {
  return page.evaluate((selector) => {
    /** A control is called by its label, or its text (what a screen reader would read). */
    const name = (element: Element): string => {
      const label = element.getAttribute('aria-label');
      if (label !== null && label !== '') {
        return label;
      }
      const text = element.textContent.replace(/\s+/g, ' ').trim();
      return text !== '' ? text : element.tagName.toLowerCase();
    };
    const root = document.querySelector(selector);
    if (root === null) {
      throw new Error(`no ${selector}`);
    }
    const candidates = root.querySelectorAll<HTMLElement>(
      'a[href], button, input, select, textarea, summary, [tabindex]',
    );
    return [...candidates]
      .filter(
        (element) =>
          element.tabIndex >= 0 &&
          !(element as HTMLButtonElement).disabled &&
          !(element instanceof HTMLInputElement && element.type === 'hidden') &&
          element.checkVisibility({ visibilityProperty: true }),
      )
      .map(name);
  }, scope);
}

/** Describes the focused element and whether its focus is visible and not covered. */
export async function currentStop(page: Page): Promise<Stop> {
  return page.evaluate(() => {
    const name = (element: Element): string => {
      const label = element.getAttribute('aria-label');
      if (label !== null && label !== '') {
        return label;
      }
      const text = element.textContent.replace(/\s+/g, ' ').trim();
      return text !== '' ? text : element.tagName.toLowerCase();
    };
    // The first element of a shadow-free page is the active element itself.
    const element = document.activeElement;
    if (element === null || element === document.body) {
      return { name: '(body)', visibleFocus: false, obscured: false };
    }
    const drawn = (target: Element): boolean => {
      const style = getComputedStyle(target);
      const outline = style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0;
      return outline || style.boxShadow !== 'none';
    };
    // A field with content inside its edge (kern's Input: the ring is on the box around the
    // <input>) draws the focus on a wrapper with :focus-within. That counts only when a rule
    // whose selector needs focus is what draws it, so a wrapper with a permanent outline does not.
    const focusRules = (rules: CSSRuleList): CSSStyleRule[] =>
      [...rules].flatMap((rule) => {
        if (rule instanceof CSSStyleRule) {
          const draws = rule.style.outlineStyle !== '' || rule.style.outline !== '';
          return rule.selectorText.includes(':focus') && draws ? [rule] : [];
        }
        return rule instanceof CSSGroupingRule ? focusRules(rule.cssRules) : [];
      });
    const wrapperRing = (): boolean => {
      const rules = [...document.styleSheets].flatMap((sheet) => focusRules(sheet.cssRules));
      let wrapper = element.parentElement;
      for (let depth = 0; wrapper !== null && depth < 2; depth += 1) {
        const candidate = wrapper;
        if (
          candidate.matches(':focus-within') &&
          drawn(candidate) &&
          rules.some((rule) => {
            try {
              return candidate.matches(rule.selectorText);
            } catch {
              return false; // a selector with a pseudo-element never matches an element
            }
          })
        ) {
          return true;
        }
        wrapper = candidate.parentElement;
      }
      return false;
    };
    // WCAG 2.4.11: the focused element is not entirely hidden. Firefox scrolls a partly visible
    // element no further, so the middle of the visible part is what is looked at.
    const rect = element.getBoundingClientRect();
    const left = Math.max(rect.left, 0);
    const right = Math.min(rect.right, innerWidth);
    const top = Math.max(rect.top, 0);
    const bottom = Math.min(rect.bottom, innerHeight);
    const hit =
      left < right && top < bottom
        ? document.elementFromPoint((left + right) / 2, (top + bottom) / 2)
        : null;
    return {
      name: name(element),
      visibleFocus: drawn(element) || wrapperRing(),
      obscured: hit === null || !(element.contains(hit) || hit.contains(element)),
    };
  });
}

/**
 * Presses Tab once per focusable element and returns what had focus after each press. Together
 * with `focusableNames` this proves that Tab reaches every control, in document order, and that
 * nothing holds the focus back.
 */
export async function walkWithTab(page: Page, count: number): Promise<Stop[]> {
  const stops: Stop[] = [];
  for (let step = 0; step < count; step += 1) {
    await page.keyboard.press('Tab');
    // The browser scrolls the focused element into view; Firefox does it a moment after the key.
    await expect
      .poll(async () => (await currentStop(page)).obscured, { message: 'focused element in view' })
      .toBe(false)
      .catch(() => undefined);
    stops.push(await currentStop(page));
  }
  return stops;
}

/** The whole rule set for one page: order, no trap, visible focus, nothing covered. */
export async function expectKeyboardOnly(page: Page, label: string): Promise<string[]> {
  // A fresh page has focus on the document: the first Tab starts at the skip link.
  const expected = await focusableNames(page);
  expect(expected.length, `${label}: something to tab to`).toBeGreaterThan(1);
  const stops = await walkWithTab(page, expected.length);
  expect(
    stops.map((stop) => stop.name),
    `${label}: Tab visits every control in document order`,
  ).toEqual(expected);
  for (const stop of stops) {
    expect(stop.visibleFocus, `${label}: "${stop.name}" shows its focus`).toBe(true);
    expect(stop.obscured, `${label}: "${stop.name}" is not covered when focused`).toBe(false);
  }
  // One more Tab leaves the last control (to the browser or around to the first): no trap.
  await page.keyboard.press('Tab');
  expect(
    (await currentStop(page)).name,
    `${label}: focus moves on after the last control`,
  ).not.toBe(expected.at(-1));
  return expected;
}

/**
 * A modal dialog (native `showModal`) makes the page behind it inert. Tab and Shift+Tab then cycle
 * through the dialog's own controls and, at the ends, through the browser's own interface (focus
 * is on nothing in the page at that moment); they never land on the page behind the dialog.
 */
export async function expectFocusStaysInDialog(page: Page): Promise<void> {
  const where = async (): Promise<'dialog' | 'browser' | 'page'> =>
    page.evaluate(() => {
      const active = document.activeElement;
      if (active === null || active === document.body || active === document.documentElement) {
        return 'browser';
      }
      return document.querySelector('dialog[open]')?.contains(active) === true ? 'dialog' : 'page';
    });
  const seen = new Set<string>();
  for (const key of [
    'Tab',
    'Tab',
    'Tab',
    'Tab',
    'Tab',
    'Tab',
    'Shift+Tab',
    'Shift+Tab',
    'Shift+Tab',
  ]) {
    await page.keyboard.press(key);
    const place = await where();
    expect(place, `${key} never lands on the page behind the dialog`).not.toBe('page');
    if (place === 'dialog') {
      seen.add((await currentStop(page)).name);
    }
  }
  expect(seen.size, 'the keys move through more than one control of the dialog').toBeGreaterThan(1);
}

/** Waits for the first render, so that Tab starts from a finished page. */
export async function open(page: Page, path: string, heading: string | RegExp): Promise<void> {
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
}
