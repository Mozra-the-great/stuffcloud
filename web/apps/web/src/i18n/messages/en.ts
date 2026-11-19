import type { Message } from '../types.ts';

/**
 * English catalogue and the source of the message keys: `MessageKey` is derived from it, every
 * other locale must provide exactly these keys (checked by the compiler and by tests/i18n.test.ts,
 * which also fails on unused keys, placeholder mismatches and wrong plural forms).
 * Keys are `area.name`; `{name}` is a placeholder, plural messages read `{count}`.
 */
export const en = {
  'skip.toContent': 'Skip to content',

  'nav.main': 'Main',
  'nav.tools': 'Tools',
  'nav.menuOpen': 'Open menu',
  'nav.menuClose': 'Close menu',

  'search.open': 'Search tools',
  'search.title': 'Search tools',
  'search.label': 'Search',
  'search.close': 'Close',
  'search.results': 'Search results',
  'search.none': 'No tools found',
  'search.count': { one: '{count} tool found', other: '{count} tools found' },

  'language.label': 'Language',

  'footer.tagline': 'GPL-3.0 · no trackers',
  'footer.source': 'Source',

  'offline.title': 'No connection',
  'offline.hint': 'Tools you already opened keep working.',

  'status.loading': 'Loading page',
  'status.navigated': 'Navigated to {title}',
  'toast.region': 'Notifications',
  'toast.dismiss': 'Dismiss',

  'home.title': 'Your stuff, in your cloud.',
  'home.openTools': 'Open the tools',

  'tools.title': 'Tools',
  'tools.categories': 'Categories',
  'tools.all': 'All',
  'tools.empty': 'No tools yet',
  'tools.count': { one: '{count} tool', other: '{count} tools' },

  'category.pdf': 'PDF',
  'category.image': 'Images',
  'category.convert': 'Convert',
  'category.parse': 'Parse',
  'category.network': 'Network',
  'category.text': 'Text',
  'category.extra': 'Extras',

  'notFound.title': 'Nothing here',
  'notFound.home': 'Go to stuffcloud',

  'error.title': 'Something went wrong',
  'error.retry': 'Try again',
} as const satisfies Readonly<Record<string, Message>>;

export type MessageKey = keyof typeof en;
