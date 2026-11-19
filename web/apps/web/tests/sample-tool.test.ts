import { render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildRegistry } from '../src/app/registry.ts';
import Shell from '../src/app/Shell.svelte';
import { stickerUrl } from '../src/app/stickers.ts';
import { i18n } from '../src/i18n/index.ts';
import { createRouter, must, settle } from './app-helpers.ts';
import sample from './fixtures/sample-tool/manifest.ts';
import { SAMPLE_CATALOGS } from './fixtures/sample-tool/messages.ts';
import { openTool } from './tool-helpers.ts';

/**
 * Issue #12: "A sample tool appears in navigation, search and routing from its manifest alone."
 * The app below is built from nothing but `fixtures/sample-tool/manifest.ts`.
 */
function renderApp(
  path: string,
  manifest: Record<string, unknown> = sample as never,
  config?: unknown,
): void {
  const { entries } = buildRegistry(
    { './sample-tool/manifest.ts': { default: manifest } },
    { catalogs: SAMPLE_CATALOGS, ...(config === undefined ? {} : { config }) },
  );
  window.history.replaceState(null, '', path);
  render(Shell, { router: createRouter(entries), tools: entries });
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the sample tool in navigation', () => {
  it('is listed on the tools page with its name, category and sticker', async () => {
    renderApp('/tools');
    await heading('Tools');
    const link = screen.getByRole('link', { name: /Sample tool/ });
    expect(link.getAttribute('href')).toBe('/tools/sample-tool');
    expect(within(link).getByText('Text')).toBeTruthy();
    const image = must(link.querySelector('img'));
    expect(image.getAttribute('src')).toBe(stickerUrl('textops'));
    expect(image.getAttribute('alt')).toBe('');
    expect(screen.getByText('1 tool')).toBeTruthy();
  });

  it('offers its category and filters by it', async () => {
    renderApp('/tools?category=text');
    await heading('Tools');
    const nav = screen.getByRole('navigation', { name: 'Categories' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((entry) => entry.textContent.trim()),
    ).toEqual(['All', 'Text']);
    expect(screen.getByRole('link', { name: /Sample tool/ })).toBeTruthy();
  });

  it('shows the name in German after switching the language', async () => {
    renderApp('/tools');
    await heading('Tools');
    i18n.setLocale('de');
    await settle();
    expect(screen.getByRole('link', { name: /Beispiel-Tool/ })).toBeTruthy();
  });

  it('is gone from the list when tools.config.json disables it', async () => {
    renderApp('/tools', sample as never, { disabled: ['sample-tool'] });
    await heading('Tools');
    expect(screen.queryByRole('link', { name: /Sample tool/ })).toBeNull();
    expect(screen.getByText('No tools yet')).toBeTruthy();
  });
});

describe('the sample tool in search', () => {
  async function search(query: string): Promise<HTMLElement> {
    const user = userEvent.setup();
    renderApp('/');
    await heading('Your stuff, in your cloud.');
    await user.keyboard('{Control>}k{/Control}');
    const dialog = must(document.querySelector('dialog'));
    await user.type(within(dialog).getByRole('searchbox', { name: 'Search' }), query);
    return dialog;
  }

  it.each([
    ['its name', 'sample'],
    ['its id', 'sample-tool'],
    ['a keyword', 'demo'],
    ['a keyword of the other language', 'beispiel'],
    ['the name of the other language', 'Beispiel-Tool'],
  ])('finds it by %s', async (_how, query) => {
    const dialog = await search(query);
    const results = within(dialog).getByRole('list', { name: 'Search results' });
    expect(within(results).getByRole('link', { name: /Sample tool/ })).toBeTruthy();
    expect(within(dialog).getByText('1 tool found')).toBeTruthy();
  });

  it('does not find it by a word that only appears in its description', async () => {
    const dialog = await search('wired');
    expect(within(dialog).getByText('No tools found')).toBeTruthy();
  });

  it('opens it with Enter', async () => {
    const user = userEvent.setup();
    const dialog = await search('demo');
    expect(dialog.hasAttribute('open')).toBe(true);
    await user.keyboard('{Enter}');
    await heading('Sample tool');
    expect(window.location.pathname).toBe('/tools/sample-tool');
  });

  it('does not find a disabled tool', async () => {
    const user = userEvent.setup();
    renderApp('/', sample as never, { disabled: ['sample-tool'] });
    await heading('Your stuff, in your cloud.');
    await user.keyboard('{Control>}k{/Control}');
    const dialog = must(document.querySelector('dialog'));
    await user.type(within(dialog).getByRole('searchbox', { name: 'Search' }), 'sample');
    expect(within(dialog).getByText('No tools found')).toBeTruthy();
  });
});

describe('the sample tool in routing', () => {
  it('opens at /tools/<id> as a deep link with exactly one h1, the name from the catalogue', async () => {
    const view = await openTool(sample, SAMPLE_CATALOGS);
    expect(view.path).toBe('/tools/sample-tool');
    expect(view.headings).toEqual(['Sample tool']);
    expect(screen.getByTestId('sample-body').textContent).toBe('Sample tool body');
    expect(view.main.textContent).toContain('Does nothing, to show how a tool is wired.');
  });

  it('is found through every route of the registry and by nothing else', async () => {
    const view = await openTool(sample, SAMPLE_CATALOGS);
    expect(view.searchHits('demo')).toEqual(['sample-tool']);
    expect(view.searchHits('nothing-like-it')).toEqual([]);
  });

  it('moves focus to the h1 and sets the title when opened from the list', async () => {
    const user = userEvent.setup();
    renderApp('/tools');
    await heading('Tools');
    await user.click(screen.getByRole('link', { name: /Sample tool/ }));
    const title = await heading('Sample tool');
    await settle();
    expect(document.activeElement).toBe(title);
    expect(document.title).toBe('Sample tool · stuffcloud');
  });

  it('renders the name, description and privacy note in German after a language switch', async () => {
    renderApp('/tools/sample-tool');
    await heading('Sample tool');
    i18n.setLocale('de');
    await heading('Beispiel-Tool');
    const main = screen.getByRole('main');
    expect(main.textContent).toContain('Tut nichts, zeigt nur die Verdrahtung eines Tools.');
    expect(main.textContent).toContain('Deine Dateien bleiben in diesem Browser');
    expect(main.querySelectorAll('h1')).toHaveLength(1);
  });

  it('says that files stay in the browser, on every tool page', async () => {
    const view = await openTool(sample, SAMPLE_CATALOGS);
    expect(view.main.textContent).toContain(
      'Your files stay in this browser. Nothing is uploaded.',
    );
  });

  it('shows the not-found page when the tool is disabled', async () => {
    renderApp('/tools/sample-tool', sample as never, { disabled: ['sample-tool'] });
    await heading('Nothing here');
    expect(screen.queryByTestId('sample-body')).toBeNull();
  });

  it('shows a tool that frames another id as an error, not as a wrong page', async () => {
    const broken = { ...sample, load: () => import('./fixtures/sample-tool/WrongFrame.svelte') };
    renderApp('/tools/sample-tool', broken);
    await heading('Something went wrong');
  });
});

describe('browser capabilities', () => {
  const needsWorker = { ...sample, requires: ['worker'] };
  const needsTwo = { ...sample, requires: ['worker', 'webcrypto'] };

  it('shows a notice instead of the tool when the browser lacks a capability', async () => {
    vi.stubGlobal('Worker', undefined);
    renderApp('/tools/sample-tool', needsWorker);
    await heading('Sample tool');
    expect(screen.getByRole('main').textContent).toContain(
      'This browser cannot run this tool. Missing: Web Workers.',
    );
    expect(screen.queryByTestId('sample-body')).toBeNull();
    expect(screen.getByRole('main').querySelectorAll('h1')).toHaveLength(1);
  });

  it('lists several missing capabilities as one sentence, in the current language', async () => {
    vi.stubGlobal('Worker', undefined);
    vi.stubGlobal('crypto', {});
    renderApp('/tools/sample-tool', needsTwo);
    await heading('Sample tool');
    expect(screen.getByRole('main').textContent).toContain(
      'Missing: Web Workers and Web Crypto (needs a secure connection).',
    );
    i18n.setLocale('de');
    await heading('Beispiel-Tool');
    expect(screen.getByRole('main').textContent).toContain(
      'Es fehlt: Web Workers und Web Crypto (braucht eine sichere Verbindung).',
    );
  });

  it('shows the tool when the browser has what it needs', async () => {
    vi.stubGlobal('Worker', vi.fn());
    renderApp('/tools/sample-tool', needsWorker);
    await heading('Sample tool');
    expect(screen.getByTestId('sample-body')).toBeTruthy();
    expect(screen.getByRole('main').textContent).not.toContain('cannot run this tool');
  });
});
