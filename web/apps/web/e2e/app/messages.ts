import type { Locale } from '../../src/i18n/locales.ts';
import type { Catalog } from '../../src/i18n/types.ts';
import { SAMPLE_CATALOGS } from '../../tests/fixtures/sample-tool/messages.ts';

/**
 * The shipped catalogues plus the texts of the sample tool (the fixture of the registry tests)
 * and of the test-only tools. Tools read their name, description and keywords from here, like
 * every tool does from the real catalogues.
 */
export const E2E_CATALOGS: Readonly<Record<Locale, Catalog>> = {
  en: {
    ...SAMPLE_CATALOGS.en,
    'tool.worker-lab.name': 'Worker lab',
    'tool.worker-lab.description':
      'Hashes files in a pool of workers, to test the pool in a real browser.',
    'tool.worker-lab.keywords': 'worker pool digest',
    'tool.leaky-tool.name': 'Leaky tool',
    'tool.leaky-tool.description':
      'Sends file content away on purpose, to prove the privacy test notices.',
    'tool.leaky-tool.keywords': 'leak privacy',
  },
  de: {
    ...SAMPLE_CATALOGS.de,
    'tool.worker-lab.name': 'Worker-Labor',
    'tool.worker-lab.description':
      'Berechnet Hashes in einem Worker-Pool, um den Pool im echten Browser zu testen.',
    'tool.worker-lab.keywords': 'worker pool pruefsumme',
    'tool.leaky-tool.name': 'Leck-Tool',
    'tool.leaky-tool.description':
      'Schickt Dateiinhalt absichtlich weg, damit der Datenschutztest anschlägt.',
    'tool.leaky-tool.keywords': 'leck datenschutz',
  },
};
