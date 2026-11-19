import { APP_NAME } from './brand.ts';

/** The page's own heading: every routed page renders exactly one `<h1>` inside `<main>`. */
export function pageHeading(main: HTMLElement): HTMLElement | null {
  return main.querySelector('h1');
}

/**
 * Moves keyboard and screen-reader focus to the page heading (or to `<main>` itself when a page
 * has none), so a navigation without a page load is as clear as one with it.
 */
export function focusHeading(main: HTMLElement): void {
  const target = pageHeading(main) ?? main;
  if (!target.hasAttribute('tabindex')) {
    target.setAttribute('tabindex', '-1');
  }
  target.focus({ preventScroll: true });
}

/** Text of the heading, or an empty string when there is none. */
export function headingText(main: HTMLElement): string {
  return pageHeading(main)?.textContent.trim() ?? '';
}

/** Browser tab title: `Page · stuffcloud`, or just the name when the page has no heading. */
export function documentTitle(heading: string): string {
  return heading === '' || heading === APP_NAME ? APP_NAME : `${heading} · ${APP_NAME}`;
}
