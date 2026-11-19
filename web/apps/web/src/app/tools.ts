import { LOCALES, type Locale, type MessageKey } from '../i18n/index.ts';
import type { RouteModule } from './router/router.svelte.ts';

/** Tool areas of SPEC 7, in navigation order. */
export const TOOL_CATEGORIES = [
  'pdf',
  'image',
  'convert',
  'parse',
  'network',
  'text',
  'extra',
] as const;

export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

export const CATEGORY_LABELS: Readonly<Record<ToolCategory, MessageKey>> = {
  pdf: 'category.pdf',
  image: 'category.image',
  convert: 'category.convert',
  parse: 'category.parse',
  network: 'category.network',
  text: 'category.text',
  extra: 'category.extra',
};

export function isToolCategory(value: string): value is ToolCategory {
  return (TOOL_CATEGORIES as readonly string[]).includes(value);
}

/**
 * What the shell needs to know about a tool: where it lives, how it is listed and found.
 * The tool registry (T-04, #12) builds these from the tool manifests; the tool itself is
 * loaded lazily and renders its own `<h1>`.
 */
export interface ToolEntry {
  /** Lowercase id; the tool lives at `/tools/<id>`. */
  readonly id: string;
  readonly category: ToolCategory;
  /** The name in every shipped language. */
  readonly name: Readonly<Record<Locale, string>>;
  readonly load: () => Promise<RouteModule>;
}

export function toolPath(id: string): string {
  return `/tools/${encodeURIComponent(id)}`;
}

/** Tools of one category, or all of them; the order of `entries` is kept. */
export function toolsInCategory(
  entries: readonly ToolEntry[],
  category: ToolCategory | undefined,
): readonly ToolEntry[] {
  return category === undefined ? entries : entries.filter((entry) => entry.category === category);
}

/** Categories that have at least one tool, in navigation order. */
export function usedCategories(entries: readonly ToolEntry[]): readonly ToolCategory[] {
  return TOOL_CATEGORIES.filter((category) => entries.some((entry) => entry.category === category));
}

/** Lowercase and without diacritics, so that `uber` finds `Über`. */
export function foldText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

/**
 * Tools whose id or name (in any language) contains every word of `query`, sorted by the
 * name in `locale`. An empty query finds nothing: the caller shows the whole list instead.
 */
export function searchTools(
  entries: readonly ToolEntry[],
  query: string,
  locale: Locale,
): readonly ToolEntry[] {
  const words = foldText(query)
    .split(/\s+/)
    .filter((word) => word !== '');
  if (words.length === 0) {
    return [];
  }
  return entries
    .filter((entry) => {
      const haystack = foldText([entry.id, ...LOCALES.map((l) => entry.name[l])].join(' '));
      return words.every((word) => haystack.includes(word));
    })
    .toSorted((a, b) => a.name[locale].localeCompare(b.name[locale], locale));
}
