import { render, screen } from '@testing-library/svelte';
import type { ToolManifest } from '@stuffcloud/tools';
import { buildRegistry } from '../src/app/registry.ts';
import type { RouteModule } from '../src/app/router/router.svelte.ts';
import type { Router } from '../src/app/router/router.svelte.ts';
import Shell from '../src/app/Shell.svelte';
import { searchTools, type ToolEntry } from '../src/app/tools.ts';
import { i18n, type Locale } from '../src/i18n/index.ts';
import type { Catalog } from '../src/i18n/types.ts';
import { createRouter } from './app-helpers.ts';

export interface OpenedTool {
  readonly router: Router;
  readonly entries: readonly ToolEntry[];
  /** The path the page was opened at. */
  readonly path: string;
  /** Text of every `<h1>` on the page (a tool page has exactly one). */
  readonly headings: readonly string[];
  readonly main: HTMLElement;
  /** Ids of the tools the search finds for `query` (English). */
  readonly searchHits: (query: string) => readonly string[];
}

/**
 * Opens one tool the way a visitor does: the registry is built from its manifest alone, the
 * shell renders and the router loads `/tools/<id>`. Resolves when the tool's heading is there.
 */
export async function openTool(
  manifest: ToolManifest<string, RouteModule>,
  catalogs?: Readonly<Record<Locale, Catalog>>,
): Promise<OpenedTool> {
  i18n.setLocale('en');
  const { entries } = buildRegistry(
    { [`./${manifest.id}/manifest.ts`]: { default: manifest } },
    catalogs === undefined ? {} : { catalogs },
  );
  const path = `/tools/${manifest.id}`;
  window.history.replaceState(null, '', path);
  const router = createRouter(entries);
  render(Shell, { router, tools: entries });
  await screen.findByRole('heading', { level: 1 });
  const main = screen.getByRole('main');
  return {
    router,
    entries,
    path: window.location.pathname,
    headings: [...main.querySelectorAll('h1')].map((heading) => heading.textContent),
    main,
    searchHits: (query) => searchTools(entries, query, 'en').map((entry) => entry.id),
  };
}
