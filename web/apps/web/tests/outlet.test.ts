import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Announcer } from '../src/app/announcer.svelte.ts';
import Outlet from '../src/app/Outlet.svelte';
import { buildRoutes } from '../src/app/routes.ts';
import type { RouteModule } from '../src/app/router/router.svelte.ts';
import Shell from '../src/app/Shell.svelte';
import { i18n } from '../src/i18n/index.ts';
import { brokenState } from './broken-state.ts';
import { createRouter, makeTool, settle, must } from './app-helpers.ts';

interface Deferred {
  readonly promise: Promise<RouteModule>;
  readonly resolve: () => void;
  readonly reject: (reason: Error) => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  let reject: (reason: Error) => void = () => undefined;
  const promise = new Promise<RouteModule>((ok, fail) => {
    resolve = (): void => {
      void import('./ToolPage.svelte').then(ok, fail);
    };
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  i18n.setLocale('en');
});

afterEach(() => {
  window.history.replaceState(null, '', '/');
  window.localStorage.clear();
  vi.restoreAllMocks();
  brokenState.broken = true;
});

describe('load failures', () => {
  it('shows an error page with a retry button, and recovers when the retry works', async () => {
    const user = userEvent.setup();
    let fail = true;
    const tool = makeTool('flaky', 'text', 'Flaky', 'Wacklig', () =>
      fail ? Promise.reject(new TypeError('chunk failed')) : import('./ToolPage.svelte'),
    );
    window.history.replaceState(null, '', '/tools/flaky');
    const router = createRouter([tool]);
    render(Shell, { props: { router, tools: [tool] } });

    const title = await screen.findByRole('heading', { level: 1, name: 'Something went wrong' });
    expect(document.activeElement).toBe(title);
    expect(document.querySelector('[data-mascot="cumulo"]')).not.toBeNull();
    expect(document.title).toBe('Something went wrong · stuffcloud');

    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    const page = await screen.findByRole('heading', { level: 1, name: 'Tool flaky' });
    await settle();
    expect(document.activeElement).toBe(page);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(
      screen.getAllByRole('status').some((node) => node.textContent === 'Navigated to Tool flaky'),
    ).toBe(true);
  });

  it('says there is no connection when the browser is offline', async () => {
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    const tool = makeTool('flaky', 'text', 'Flaky', 'Wacklig', () =>
      Promise.reject(new Error('x')),
    );
    window.history.replaceState(null, '', '/tools/flaky');
    render(Shell, { props: { router: createRouter([tool]), tools: [tool] } });

    expect(await screen.findByRole('heading', { level: 1, name: 'No connection' })).toBeTruthy();
    expect(screen.getAllByText('Tools you already opened keep working.').length).toBeGreaterThan(0);
  });

  it('keeps going after a failed page: another link works', async () => {
    const user = userEvent.setup();
    const tool = makeTool('flaky', 'text', 'Flaky', 'Wacklig', () =>
      Promise.reject(new Error('x')),
    );
    window.history.replaceState(null, '', '/tools/flaky');
    render(Shell, { props: { router: createRouter([tool]), tools: [tool] } });
    await screen.findByRole('heading', { level: 1, name: 'Something went wrong' });

    await user.click(must(screen.getAllByRole('link', { name: 'Tools' })[0]));

    expect(await screen.findByRole('heading', { level: 1, name: 'Tools' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});

describe('render errors', () => {
  const broken = makeTool(
    'broken',
    'text',
    'Broken',
    'Kaputt',
    () => import('./BrokenPage.svelte'),
  );

  it('catches an error while a page renders and lets the visitor retry', async () => {
    const user = userEvent.setup();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    window.history.replaceState(null, '', '/tools/broken');
    render(Shell, { props: { router: createRouter([broken]), tools: [broken] } });

    const title = await screen.findByRole('heading', { level: 1, name: 'Something went wrong' });
    expect(document.activeElement).toBe(title);
    expect(title.closest('section')?.getAttribute('data-cause')).toBe('TypeError');
    expect(screen.getByRole('banner')).toBeTruthy();

    brokenState.broken = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Fixed page' })).toBeTruthy();
    errors.mockRestore();
  });

  it('shows no cause for something that was thrown but is not an error', async () => {
    const ErrorState = (await import('../src/app/ErrorState.svelte')).default;
    render(ErrorState, { props: { offline: false, onretry: () => undefined, cause: 'text' } });
    expect(document.querySelector('section')?.hasAttribute('data-cause')).toBe(false);
  });
});

describe('loading', () => {
  it('keeps the old page while the next one loads and shows a progress bar after the delay', async () => {
    const slow = deferred();
    const tool = makeTool('slow', 'text', 'Slow', 'Langsam', () => slow.promise);
    window.history.replaceState(null, '', '/');
    const router = createRouter([tool]);
    const stop = router.start();
    const announcer = new Announcer();
    render(Outlet, { props: { router, offline: false, announcer, progressDelayMs: 0 } });
    await screen.findByRole('heading', { level: 1, name: 'Your stuff, in your cloud.' });
    expect(screen.queryByRole('progressbar')).toBeNull();

    // No Shell here, so there is no link list to click: navigate directly.
    router.navigate('/tools/slow');
    await settle();

    expect(screen.getByRole('main').getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('progressbar', { name: 'Loading page' })).toBeTruthy();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Your stuff, in your cloud.' }),
    ).toBeTruthy();

    slow.resolve();
    await screen.findByRole('heading', { level: 1, name: 'Tool slow' });
    await settle();

    expect(screen.getByRole('main').getAttribute('aria-busy')).toBe('false');
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(announcer.message).toBe('Navigated to Tool slow');
    stop();
  });

  it('shows no progress bar when the page arrives within the delay', async () => {
    window.history.replaceState(null, '', '/');
    const router = createRouter([]);
    const stop = router.start();
    render(Outlet, {
      props: { router, offline: false, announcer: new Announcer(), progressDelayMs: 60_000 },
    });
    await screen.findByRole('heading', { level: 1, name: 'Your stuff, in your cloud.' });
    router.navigate('/nope');
    await screen.findByRole('heading', { level: 1, name: 'Nothing here' });
    expect(screen.queryByRole('progressbar')).toBeNull();
    stop();
  });

  it('ignores a page that arrives after the visitor moved on', async () => {
    const slow = deferred();
    const tool = makeTool('slow', 'text', 'Slow', 'Langsam', () => slow.promise);
    window.history.replaceState(null, '', '/');
    const router = createRouter([tool]);
    const stop = router.start();
    const announcer = new Announcer();
    render(Outlet, { props: { router, offline: false, announcer } });
    await screen.findByRole('heading', { level: 1, name: 'Your stuff, in your cloud.' });

    router.navigate('/tools/slow');
    await settle();
    router.navigate('/nope');
    await screen.findByRole('heading', { level: 1, name: 'Nothing here' });
    slow.resolve();
    await settle();

    expect(screen.getByRole('heading', { level: 1, name: 'Nothing here' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Tool slow' })).toBeNull();
    expect(window.location.pathname).toBe('/nope');
    stop();
  });

  it('ignores a failure that arrives after the visitor moved on', async () => {
    const slow = deferred();
    const tool = makeTool('slow', 'text', 'Slow', 'Langsam', () => slow.promise);
    window.history.replaceState(null, '', '/');
    const router = createRouter([tool]);
    const stop = router.start();
    render(Outlet, { props: { router, offline: false, announcer: new Announcer() } });
    await screen.findByRole('heading', { level: 1, name: 'Your stuff, in your cloud.' });

    router.navigate('/tools/slow');
    await settle();
    router.navigate('/nope');
    await screen.findByRole('heading', { level: 1, name: 'Nothing here' });
    slow.reject(new Error('late failure'));
    await settle();

    expect(screen.queryByRole('heading', { name: 'Something went wrong' })).toBeNull();
    stop();
  });

  it('does not touch the page when the shell goes away while a page is loading', async () => {
    const slow = deferred();
    const tool = makeTool('slow', 'text', 'Slow', 'Langsam', () => slow.promise);
    window.history.replaceState(null, '', '/');
    const router = createRouter([tool]);
    const { unmount } = render(Shell, { props: { router, tools: [tool] } });
    await screen.findByRole('heading', { level: 1, name: 'Your stuff, in your cloud.' });

    router.navigate('/tools/slow');
    await settle();
    unmount();
    slow.resolve();
    await settle();

    // A late page must neither throw (an unhandled rejection fails the run) nor change the title.
    expect(screen.queryByRole('main')).toBeNull();
  });

  it('builds a route per tool and a lazy not-found route', async () => {
    const { routes, notFound } = buildRoutes([makeTool('a', 'pdf', 'A', 'A')]);
    expect(routes.map((route) => route.path)).toEqual(['/', '/tools', '/tools/a']);
    expect(routes.map((route) => route.id)).toEqual(['home', 'tools', 'tool:a']);
    for (const route of [...routes.slice(0, 2), notFound]) {
      const module = await route.load();
      expect(typeof module.default).toBe('function');
    }
  });
});
