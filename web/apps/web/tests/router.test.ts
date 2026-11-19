import { afterEach, describe, expect, it, vi } from 'vitest';
import { closestLink, isInternalNavigation } from '../src/app/router/links.ts';
import { matchPath, normalisePath } from '../src/app/router/match.ts';
import {
  Router,
  resolveRoute,
  type RouteDefinition,
  type RouteModule,
} from '../src/app/router/router.svelte.ts';

describe('normalisePath', () => {
  it('drops one trailing slash except for the root', () => {
    expect(normalisePath('/')).toBe('/');
    expect(normalisePath('/tools/')).toBe('/tools');
    expect(normalisePath('/tools')).toBe('/tools');
  });
});

describe('matchPath', () => {
  it('matches literal paths exactly', () => {
    expect(matchPath('/', '/')).toEqual({});
    expect(matchPath('/tools', '/tools')).toEqual({});
    expect(matchPath('/tools', '/tools/')).toEqual({});
    expect(matchPath('/tools', '/Tools')).toBeUndefined();
    expect(matchPath('/tools', '/tool')).toBeUndefined();
    expect(matchPath('/tools', '/tools/x')).toBeUndefined();
    expect(matchPath('/tools/x', '/tools')).toBeUndefined();
    expect(matchPath('/', '/tools')).toBeUndefined();
  });

  it('extracts parameters', () => {
    expect(matchPath('/tools/:id', '/tools/merge-pdf')).toEqual({ id: 'merge-pdf' });
    expect(matchPath('/a/:x/b/:y', '/a/1/b/2')).toEqual({ x: '1', y: '2' });
  });

  it('decodes percent escapes in parameters', () => {
    expect(matchPath('/tools/:id', '/tools/a%20b')).toEqual({ id: 'a b' });
    expect(matchPath('/tools/:id', '/tools/a%2Fb')).toEqual({ id: 'a/b' });
  });

  it('never matches an empty parameter or a malformed escape', () => {
    expect(matchPath('/tools/:id', '/tools/')).toBeUndefined();
    expect(matchPath('/tools/:id', '/tools//')).toBeUndefined();
    expect(matchPath('/tools/:id', '/tools/%E0%A4%A')).toBeUndefined();
    expect(matchPath('/tools/:id', '/tools/%')).toBeUndefined();
  });

  it('does not let a parameter span several segments', () => {
    expect(matchPath('/tools/:id', '/tools/a/b')).toBeUndefined();
  });
});

describe('isInternalNavigation', () => {
  const click = {
    button: 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
  };

  function link(href: string, attributes: Record<string, string> = {}): HTMLAnchorElement {
    const anchor = document.createElement('a');
    anchor.setAttribute('href', href);
    for (const [name, value] of Object.entries(attributes)) {
      anchor.setAttribute(name, value);
    }
    return anchor;
  }

  const here = window.location;

  it('takes plain same-origin clicks', () => {
    expect(isInternalNavigation(click, link('/tools'), here)).toBe(true);
    expect(isInternalNavigation(click, link('/tools?category=pdf'), here)).toBe(true);
    expect(isInternalNavigation(click, link('/tools', { target: '_self' }), here)).toBe(true);
    expect(isInternalNavigation(click, link('/tools', { target: '' }), here)).toBe(true);
  });

  it.each([
    ['a middle click', { button: 1 }],
    ['ctrl', { ctrlKey: true }],
    ['meta', { metaKey: true }],
    ['shift', { shiftKey: true }],
    ['alt', { altKey: true }],
    ['a handled click', { defaultPrevented: true }],
  ])('leaves %s to the browser', (_name, change) => {
    expect(isInternalNavigation({ ...click, ...change }, link('/tools'), here)).toBe(false);
  });

  it('leaves other targets, downloads, external links and other origins alone', () => {
    expect(isInternalNavigation(click, link('/tools', { target: '_blank' }), here)).toBe(false);
    expect(isInternalNavigation(click, link('/tools', { target: 'frame' }), here)).toBe(false);
    expect(isInternalNavigation(click, link('/file.zip', { download: '' }), here)).toBe(false);
    expect(isInternalNavigation(click, link('/docs', { rel: 'noopener external' }), here)).toBe(
      false,
    );
    expect(isInternalNavigation(click, link('https://example.org/'), here)).toBe(false);
    expect(isInternalNavigation(click, link('mailto:someone@example.org'), here)).toBe(false);
  });

  it('leaves an anchor on the same page to the browser, but not a path with a fragment', () => {
    expect(isInternalNavigation(click, link(`${here.pathname}${here.search}#part`), here)).toBe(
      false,
    );
    expect(isInternalNavigation(click, link('/other#part'), here)).toBe(true);
    expect(isInternalNavigation(click, link(here.pathname), here)).toBe(true);
  });
});

describe('closestLink', () => {
  it('finds the link around a nested target', () => {
    document.body.innerHTML = '<a href="/x"><span><b id="inner">x</b></span></a><a id="bare">y</a>';
    expect(closestLink(document.getElementById('inner'))?.getAttribute('href')).toBe('/x');
    expect(closestLink(document.getElementById('bare'))).toBeUndefined();
    expect(closestLink(null)).toBeUndefined();
    expect(closestLink(window)).toBeUndefined();
    document.body.replaceChildren();
  });
});

function route(id: string, path: string): RouteDefinition {
  return {
    id,
    path,
    load: (): Promise<RouteModule> => Promise.reject(new Error('not loaded in this test')),
  };
}

describe('resolveRoute', () => {
  const home = route('home', '/');
  const tools = route('tools', '/tools');
  const tool = route('tool', '/tools/:id');
  const notFound = route('not-found', '*');
  const routes = [home, tools, tool];

  it('resolves the first matching route with params and query', () => {
    const resolved = resolveRoute(routes, notFound, '/tools/merge-pdf', '?a=1&b=2');
    expect(resolved.route).toBe(tool);
    expect(resolved.found).toBe(true);
    expect(resolved.params).toEqual({ id: 'merge-pdf' });
    expect(resolved.query.get('b')).toBe('2');
    expect(resolved.path).toBe('/tools/merge-pdf');
  });

  it('normalises the path', () => {
    expect(resolveRoute(routes, notFound, '/tools/', '').path).toBe('/tools');
  });

  it('falls back to the not-found route', () => {
    const resolved = resolveRoute(routes, notFound, '/nope', '');
    expect(resolved.route).toBe(notFound);
    expect(resolved.found).toBe(false);
    expect(resolved.params).toEqual({});
  });
});

describe('Router', () => {
  const home = route('home', '/');
  const tools = route('tools', '/tools');
  const notFound = route('not-found', '*');

  afterEach(() => {
    window.history.replaceState(null, '', '/');
    document.body.replaceChildren();
  });

  function create(leave?: (url: string) => void): Router {
    return new Router({
      routes: [home, tools],
      notFound,
      ...(leave === undefined ? {} : { leave }),
    });
  }

  it('starts at the current address (a deep link)', () => {
    window.history.replaceState(null, '', '/tools?category=pdf');
    const router = create();
    expect(router.current.route).toBe(tools);
    expect(router.current.query.get('category')).toBe('pdf');
  });

  it('navigates with pushState and updates the current route', () => {
    const router = create();
    const length = window.history.length;

    router.navigate('/tools?x=1#top');

    expect(router.current.route).toBe(tools);
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      '/tools?x=1#top',
    );
    expect(window.history.length).toBe(length + 1);
  });

  it('replaces the entry when asked to', () => {
    const router = create();
    const length = window.history.length;
    router.navigate('/tools', { replace: true });
    expect(router.current.route).toBe(tools);
    expect(window.history.length).toBe(length);
  });

  it('does nothing for the address it is already at', () => {
    const router = create();
    const push = vi.spyOn(window.history, 'pushState');
    router.navigate('/');
    router.navigate('/#fragment');
    expect(push).not.toHaveBeenCalled();
    push.mockRestore();
  });

  it('hands other origins to `leave` and never to the history', () => {
    const leave = vi.fn();
    const router = create(leave);
    const push = vi.spyOn(window.history, 'pushState');
    router.navigate('https://example.org/x');
    expect(leave).toHaveBeenCalledWith('https://example.org/x');
    expect(push).not.toHaveBeenCalled();
    expect(router.current.route).toBe(home);
    push.mockRestore();
  });

  it('shows the not-found route for an unknown path', () => {
    const router = create();
    router.navigate('/missing');
    expect(router.current.route).toBe(notFound);
    expect(router.current.found).toBe(false);
  });

  it('intercepts clicks on internal links once started, and stops when told to', () => {
    const router = create();
    const stop = router.start();
    document.body.innerHTML = '<a id="go" href="/tools"><span id="inner">Tools</span></a>';

    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    document.getElementById('inner')?.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(router.current.route).toBe(tools);

    stop();
    router.navigate('/');
    const after = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    // jsdom would try to navigate on an unhandled click: keep it from doing so.
    document.getElementById('go')?.addEventListener('click', (e) => {
      e.preventDefault();
    });
    document.getElementById('go')?.dispatchEvent(after);
    expect(router.current.route).toBe(home);
  });

  it('does not intercept modified clicks or external links', () => {
    const router = create();
    const stop = router.start();
    document.body.innerHTML =
      '<a id="a" href="/tools">a</a><a id="b" href="https://example.org/">b</a>';
    for (const id of ['a', 'b']) {
      document.getElementById(id)?.addEventListener('click', (e) => {
        expect(e.defaultPrevented).toBe(false);
        e.preventDefault();
      });
    }

    document
      .getElementById('a')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
    document
      .getElementById('b')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(router.current.route).toBe(home);
    stop();
  });

  it('follows back and forward', () => {
    const router = create();
    const stop = router.start();
    router.navigate('/tools');
    expect(router.current.route).toBe(tools);

    window.history.replaceState(null, '', '/');
    window.dispatchEvent(new PopStateEvent('popstate'));

    expect(router.current.route).toBe(home);
    stop();
  });
});
