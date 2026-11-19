/**
 * Decides whether a click on a link is a navigation inside the app. Everything the browser
 * does better stays with the browser: modified clicks (new tab, download), other targets,
 * `download` and `rel="external"` links, other origins and in-page anchors.
 */
export function isInternalNavigation(
  event: Pick<
    MouseEvent,
    'button' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'defaultPrevented'
  >,
  anchor: HTMLAnchorElement,
  current: Location,
): boolean {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return false;
  }
  const target = anchor.getAttribute('target');
  if (target !== null && target !== '' && target !== '_self') {
    return false;
  }
  if (anchor.hasAttribute('download')) {
    return false;
  }
  if ((anchor.getAttribute('rel') ?? '').split(/\s+/).includes('external')) {
    return false;
  }
  if (anchor.origin !== current.origin) {
    return false;
  }
  // Same page, only the fragment differs: a jump to an anchor, not a navigation.
  const samePage = anchor.pathname === current.pathname && anchor.search === current.search;
  return !(samePage && anchor.hash !== '');
}

/** The nearest enclosing link of a click target that carries an `href`. */
export function closestLink(target: EventTarget | null): HTMLAnchorElement | undefined {
  if (!(target instanceof Element)) {
    return undefined;
  }
  const anchor = target.closest('a[href]');
  return anchor instanceof HTMLAnchorElement ? anchor : undefined;
}
