import { render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Router } from '../src/app/router/router.svelte.ts';
import Shell from '../src/app/Shell.svelte';
import type { ToolEntry } from '../src/app/tools.ts';
import { i18n } from '../src/i18n/index.ts';
import { TOOLS, createRouter, makeTool, settle, must } from './app-helpers.ts';

function renderShell(path = '/', tools: readonly ToolEntry[] = TOOLS): Router {
  window.history.replaceState(null, '', path);
  const router = createRouter(tools);
  render(Shell, { router, tools });
  return router;
}

async function heading(name: string): Promise<HTMLElement> {
  return screen.findByRole('heading', { level: 1, name });
}

beforeEach(() => {
  i18n.setLocale('en');
  document.title = '';
});

afterEach(() => {
  window.history.replaceState(null, '', '/');
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('layout', () => {
  it('has the landmarks: skip link, banner, navigation, main, footer', async () => {
    renderShell();
    await heading('Your stuff, in your cloud.');

    expect(screen.getByRole('link', { name: 'Skip to content' })).toBeTruthy();
    expect(screen.getByRole('banner')).toBeTruthy();
    expect(
      within(screen.getByRole('banner')).getAllByRole('navigation', { name: 'Main' }).length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole('main').id).toBe('main');
    const footer = screen.getByRole('contentinfo');
    expect(within(footer).getByText(/GPL-3\.0 · no trackers/)).toBeTruthy();
    expect(within(footer).getByRole('link', { name: 'Source' }).getAttribute('href')).toMatch(
      /^https:\/\/github\.com\//,
    );
  });

  it('makes the skip link the first tab stop and moves focus to main without touching the URL', async () => {
    const user = userEvent.setup();
    renderShell();
    await heading('Your stuff, in your cloud.');

    await user.tab();
    const skip = screen.getByRole('link', { name: 'Skip to content' });
    expect(document.activeElement).toBe(skip);
    await user.keyboard('{Enter}');

    expect(document.activeElement).toBe(screen.getByRole('main'));
    expect(window.location.hash).toBe('');
  });

  it('leaves the skip link alone when its target is missing', async () => {
    const { default: SkipLink } = await import('../src/app/SkipLink.svelte');
    render(SkipLink, { props: { target: 'nowhere', label: 'Skip' } });
    const link = screen.getByRole('link', { name: 'Skip' });
    link.addEventListener('click', (event) => {
      expect(event.defaultPrevented).toBe(false);
      event.preventDefault();
    });
    link.click();
  });

  it('shows the shell on a deep link without moving focus on first load', async () => {
    renderShell('/tools/merge-pdf');
    await heading('Tool merge-pdf');
    expect(document.activeElement).toBe(document.body);
    expect(document.title).toBe('Tool merge-pdf · stuffcloud');
  });

  it('marks the tools link as the current page on the tools pages only', async () => {
    renderShell('/tools');
    await heading('Tools');
    const link = within(must(screen.getAllByRole('navigation', { name: 'Main' })[0])).getByRole(
      'link',
      { name: 'Tools' },
    );
    expect(link.getAttribute('aria-current')).toBe('page');
  });

  it('does not mark it on the home page', async () => {
    renderShell('/');
    await heading('Your stuff, in your cloud.');
    const link = within(must(screen.getAllByRole('navigation', { name: 'Main' })[0])).getByRole(
      'link',
      { name: 'Tools' },
    );
    expect(link.getAttribute('aria-current')).toBeNull();
  });
});

describe('routing and focus', () => {
  it('navigates by link without a reload, then moves focus to the heading and announces it', async () => {
    const user = userEvent.setup();
    const scroll = vi.spyOn(window, 'scrollTo');
    renderShell();
    await heading('Your stuff, in your cloud.');

    await user.click(screen.getByRole('link', { name: 'Open the tools' }));
    const next = await heading('Tools');
    await settle();

    expect(window.location.pathname).toBe('/tools');
    expect(document.activeElement).toBe(next);
    expect(document.title).toBe('Tools · stuffcloud');
    expect(
      screen.getAllByRole('status').some((node) => node.textContent === 'Navigated to Tools'),
    ).toBe(true);
    expect(scroll).toHaveBeenCalledWith(0, 0);
  });

  it('opens a tool lazily and shows its page', async () => {
    const user = userEvent.setup();
    const load = vi.fn(() => import('./ToolPage.svelte'));
    renderShell('/tools', [makeTool('merge-pdf', 'pdf', 'Merge PDFs', 'PDFs zusammenfügen', load)]);
    await heading('Tools');
    expect(load).not.toHaveBeenCalled();

    await user.click(screen.getByRole('link', { name: /Merge PDFs/ }));

    await heading('Tool merge-pdf');
    expect(load).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe('/tools/merge-pdf');
  });

  it('follows the browser back button and moves focus there as well', async () => {
    const user = userEvent.setup();
    renderShell();
    await heading('Your stuff, in your cloud.');
    await user.click(screen.getByRole('link', { name: 'Open the tools' }));
    await heading('Tools');

    window.history.replaceState(null, '', '/');
    window.dispatchEvent(new PopStateEvent('popstate'));

    const home = await heading('Your stuff, in your cloud.');
    await settle();
    expect(document.activeElement).toBe(home);
  });

  it('shows the 404 page with the ghost for an unknown path', async () => {
    renderShell('/no/such/page');
    const title = await heading('Nothing here');
    expect(title).toBeTruthy();
    expect(document.title).toBe('Nothing here · stuffcloud');
    expect(document.querySelector('[data-mascot="boo"]')).not.toBeNull();
    expect(screen.getByRole('link', { name: 'Go to stuffcloud' }).getAttribute('href')).toBe('/');
  });

  it('shows the 404 page for an unknown tool id and for a malformed escape', async () => {
    renderShell('/tools/unknown-tool');
    await heading('Nothing here');
    window.history.replaceState(null, '', '/tools/%E0%A4%A');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await settle();
    expect(screen.getByRole('heading', { level: 1, name: 'Nothing here' })).toBeTruthy();
  });

  it('goes home from the 404 page', async () => {
    const user = userEvent.setup();
    renderShell('/missing');
    await heading('Nothing here');
    await user.click(screen.getByRole('link', { name: 'Go to stuffcloud' }));
    await heading('Your stuff, in your cloud.');
  });

  it('does not move focus when only the query changes', async () => {
    const user = userEvent.setup();
    renderShell('/tools');
    await heading('Tools');
    const link = screen.getByRole('link', { name: 'Images' });
    link.focus();

    await user.click(link);
    await settle();

    expect(window.location.search).toBe('?category=image');
    expect(document.activeElement).toBe(link);
  });

  it('falls back to main when a page has no heading', async () => {
    const quiet = makeTool(
      'quiet',
      'text',
      'Quiet',
      'Still',
      () => import('./HeadlessPage.svelte'),
    );
    const user = userEvent.setup();
    renderShell('/', [quiet]);
    await heading('Your stuff, in your cloud.');
    await user.click(screen.getByRole('link', { name: 'Open the tools' }));
    await heading('Tools');
    await user.click(screen.getByRole('link', { name: /Quiet/ }));
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('main'));
    });

    expect(window.location.pathname).toBe('/tools/quiet');
    expect(document.title).toBe('stuffcloud');
  });
});

describe('tools page', () => {
  it('lists the tools with a count and a link each', async () => {
    renderShell('/tools');
    await heading('Tools');
    expect(screen.getByText('3 tools')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Merge PDFs/ }).getAttribute('href')).toBe(
      '/tools/merge-pdf',
    );
    expect(screen.getAllByRole('link', { name: /PDF|image/ }).length).toBeGreaterThanOrEqual(3);
  });

  it('offers the used categories as navigation and filters by one', async () => {
    renderShell('/tools?category=pdf');
    await heading('Tools');
    const nav = screen.getByRole('navigation', { name: 'Categories' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent.trim()),
    ).toEqual(['All', 'PDF', 'Images']);
    expect(within(nav).getByRole('link', { name: 'PDF' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(screen.getByText('2 tools')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Resize image/ })).toBeNull();
  });

  it('uses the singular form for one tool', async () => {
    renderShell('/tools?category=image');
    await heading('Tools');
    expect(screen.getByText('1 tool')).toBeTruthy();
  });

  it('shows everything for an unknown category', async () => {
    renderShell('/tools?category=nope');
    await heading('Tools');
    expect(screen.getByText('3 tools')).toBeTruthy();
    expect(
      within(screen.getByRole('navigation', { name: 'Categories' }))
        .getByRole('link', { name: 'All' })
        .getAttribute('aria-current'),
    ).toBe('page');
  });

  it('shows the empty state when there are no tools', async () => {
    renderShell('/tools', []);
    await heading('Tools');
    expect(screen.getByText('No tools yet')).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Categories' })).toBeNull();
    expect(document.querySelector('[data-mascot="stuffy"]')).not.toBeNull();
  });
});

describe('language', () => {
  it('switches the whole UI without a reload and keeps the choice', async () => {
    const user = userEvent.setup();
    renderShell('/tools');
    await heading('Tools');
    const group = must(screen.getAllByRole('group', { name: 'Language' })[0]);
    const deutsch = within(group).getByRole('button', { name: 'Deutsch' });
    expect(deutsch.getAttribute('aria-pressed')).toBe('false');
    expect(
      within(group).getByRole('button', { name: 'English' }).getAttribute('aria-pressed'),
    ).toBe('true');

    await user.click(deutsch);
    await settle();

    expect(document.documentElement.lang).toBe('de');
    expect(screen.getByRole('link', { name: 'Zum Inhalt springen' })).toBeTruthy();
    expect(screen.getByText('3 Tools')).toBeTruthy();
    expect(screen.getByText('PDFs zusammenfügen')).toBeTruthy();
    expect(screen.getAllByRole('navigation', { name: 'Hauptnavigation' }).length).toBeGreaterThan(
      0,
    );
    expect(screen.getByRole('contentinfo').textContent).toContain('keine Tracker');
    expect(deutsch.getAttribute('aria-pressed')).toBe('true');
    expect(deutsch.getAttribute('lang')).toBe('de');
    expect(window.localStorage.getItem('stuffcloud.locale')).toBe('de');
    expect(window.location.pathname).toBe('/tools');

    await user.click(within(group).getByRole('button', { name: 'English' }));
    expect(screen.getByText('3 tools')).toBeTruthy();
    expect(document.documentElement.lang).toBe('en');
  });

  it('updates the tab title with the language', async () => {
    renderShell('/missing');
    await heading('Nothing here');
    expect(document.title).toBe('Nothing here · stuffcloud');

    i18n.setLocale('de');
    await settle();

    expect(document.title).toBe('Hier ist nichts · stuffcloud');
  });
});

describe('search', () => {
  it('opens with Ctrl+K, finds tools in either language and opens one with Enter', async () => {
    const user = userEvent.setup();
    renderShell('/');
    await heading('Your stuff, in your cloud.');

    await user.keyboard('{Control>}k{/Control}');
    const dialog = document.querySelector('dialog');
    expect(dialog?.hasAttribute('open')).toBe(true);

    const input = within(dialog as HTMLElement).getByRole('searchbox', { name: 'Search' });
    await user.type(input, 'zusammen');
    const results = within(dialog as HTMLElement).getByRole('list', { name: 'Search results' });
    expect(within(results).getAllByRole('link')).toHaveLength(1);
    expect(within(dialog as HTMLElement).getByText('1 tool found')).toBeTruthy();

    await user.keyboard('{Enter}');
    await heading('Tool merge-pdf');
    expect(dialog?.hasAttribute('open')).toBe(false);
    expect(window.location.pathname).toBe('/tools/merge-pdf');
  });

  it('opens from the header button and from Cmd+K', async () => {
    const user = userEvent.setup();
    renderShell('/');
    await heading('Your stuff, in your cloud.');

    await user.click(must(screen.getAllByRole('button', { name: /Search tools/ })[0]));
    expect(document.querySelector('dialog')?.hasAttribute('open')).toBe(true);
    document.querySelector('dialog')?.close();
    expect(document.querySelector('dialog')?.hasAttribute('open')).toBe(false);

    await user.keyboard('{Meta>}k{/Meta}');
    expect(document.querySelector('dialog')?.hasAttribute('open')).toBe(true);
  });

  it('ignores a bare K and other combinations', async () => {
    const user = userEvent.setup();
    renderShell('/');
    await heading('Your stuff, in your cloud.');
    await user.keyboard('k');
    await user.keyboard('{Control>}j{/Control}');
    expect(document.querySelector('dialog')?.hasAttribute('open')).toBe(false);
  });

  it('says so when nothing matches and does nothing on Enter', async () => {
    const user = userEvent.setup();
    renderShell('/');
    await heading('Your stuff, in your cloud.');
    await user.keyboard('{Control>}k{/Control}');
    const dialog = must(document.querySelector('dialog'));

    await user.type(within(dialog).getByRole('searchbox'), 'xyz{Enter}');

    expect(within(dialog).getByText('No tools found')).toBeTruthy();
    expect(within(dialog).queryByRole('list')).toBeNull();
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(window.location.pathname).toBe('/');
  });

  it('opens a result by click, closes, and starts empty next time', async () => {
    const user = userEvent.setup();
    renderShell('/');
    await heading('Your stuff, in your cloud.');
    await user.keyboard('{Control>}k{/Control}');
    const dialog = must(document.querySelector('dialog'));
    await user.type(within(dialog).getByRole('searchbox'), 'pdf');
    expect(within(dialog).getAllByRole('link')).toHaveLength(2);

    await user.click(within(dialog).getByRole('link', { name: /Split PDF/ }));
    await heading('Tool split-pdf');

    expect(dialog.hasAttribute('open')).toBe(false);
    await user.keyboard('{Control>}k{/Control}');
    expect(within(dialog).getByRole<HTMLInputElement>('searchbox').value).toBe('');
  });
});

describe('phone menu', () => {
  it('toggles with aria-expanded, closes with Escape and returns focus to its button', async () => {
    const user = userEvent.setup();
    renderShell('/');
    await heading('Your stuff, in your cloud.');
    const button = screen.getByRole('button', { name: 'Open menu' });
    const menu = must(document.getElementById('phone-menu'));
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-controls')).toBe('phone-menu');
    expect(menu.hidden).toBe(true);

    await user.click(button);
    expect(screen.getByRole('button', { name: 'Close menu' }).getAttribute('aria-expanded')).toBe(
      'true',
    );
    expect(menu.hidden).toBe(false);

    await user.keyboard('{Escape}');
    expect(menu.hidden).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open menu' }));
  });

  it('ignores Escape while closed', async () => {
    const user = userEvent.setup();
    renderShell('/');
    await heading('Your stuff, in your cloud.');
    screen.getByRole('link', { name: 'Skip to content' }).focus();
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Skip to content' }));
  });

  it('closes after a navigation', async () => {
    const user = userEvent.setup();
    renderShell('/');
    await heading('Your stuff, in your cloud.');
    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    const menu = must(document.getElementById('phone-menu'));

    await user.click(within(menu).getByRole('link', { name: 'Tools' }));
    await heading('Tools');

    expect(menu.hidden).toBe(true);
  });

  it('closes when the search opens from the menu', async () => {
    const user = userEvent.setup();
    renderShell('/');
    await heading('Your stuff, in your cloud.');
    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    const menu = must(document.getElementById('phone-menu'));

    await user.click(within(menu).getByRole('button', { name: /Search tools/ }));

    expect(menu.hidden).toBe(true);
    expect(document.querySelector('dialog')?.hasAttribute('open')).toBe(true);
  });
});

describe('offline', () => {
  it('tells the visitor when the connection is lost and when it is back', async () => {
    renderShell('/');
    await heading('Your stuff, in your cloud.');
    expect(screen.queryByText('No connection')).toBeNull();

    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    window.dispatchEvent(new Event('offline'));
    await settle();
    expect(screen.getByText('No connection')).toBeTruthy();
    expect(screen.getByText('Tools you already opened keep working.')).toBeTruthy();

    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true);
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(screen.queryByText('No connection')).toBeNull();
  });
});
