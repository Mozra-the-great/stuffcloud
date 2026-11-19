import type { Locale } from '../../../src/i18n/locales.ts';
import { de } from '../../../src/i18n/messages/de.ts';
import { en } from '../../../src/i18n/messages/en.ts';
import type { Catalog } from '../../../src/i18n/types.ts';

/** The shipped catalogues plus the three texts of the sample tool. */
export const SAMPLE_CATALOGS: Readonly<Record<Locale, Catalog>> = {
  en: {
    ...en,
    'tool.sample-tool.name': 'Sample tool',
    'tool.sample-tool.description': 'Does nothing, to show how a tool is wired.',
    'tool.sample-tool.keywords': 'example demo',
  },
  de: {
    ...de,
    'tool.sample-tool.name': 'Beispiel-Tool',
    'tool.sample-tool.description': 'Tut nichts, zeigt nur die Verdrahtung eines Tools.',
    'tool.sample-tool.keywords': 'beispiel probe',
  },
};
