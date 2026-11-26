import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { de } from '../src/i18n/messages/de.ts';
import { en } from '../src/i18n/messages/en.ts';
import { appRoot } from './helpers.ts';

/**
 * WCAG 2.5.3 (Label in Name): the Copy and Download buttons show one short word and carry the tool's
 * longer label as their accessible name (kern's `accessibleLabel`), so that name has to contain the
 * visible word in every language. kern documents this rule but does not check it.
 */
const toolsRoot = join(appRoot, 'src', 'tools');

function toolFiles(): string[] {
  return readdirSync(toolsRoot, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? [join(toolsRoot, entry.name, 'Tool.svelte')] : [],
  );
}

interface Use {
  readonly component: 'CopyButton' | 'DownloadButton';
  readonly key: string;
}

/** The catalogue keys of every `label={t('key' ...)}` on a CopyButton or DownloadButton. */
function labelKeys(): Use[] {
  const uses: Use[] = [];
  for (const file of toolFiles()) {
    const source = readFileSync(file, 'utf-8');
    for (const tag of source.matchAll(/<(CopyButton|DownloadButton)\b[^>]*?\/>/gs)) {
      const component = tag[1] as Use['component'];
      const key = /\blabel=\{t\('([^']+)'/.exec(tag[0])?.[1];
      if (key !== undefined) {
        uses.push({ component, key });
      } else if (!tag[0].includes('label={row.copy}')) {
        throw new Error(`${file}: a ${component} label that is neither t('key') nor row.copy`);
      }
    }
  }
  return uses;
}

describe('names of the Copy and Download buttons', () => {
  const uses = labelKeys();
  const catalogs = [
    { locale: 'en', messages: en as Readonly<Record<string, unknown>> },
    { locale: 'de', messages: de as Readonly<Record<string, unknown>> },
  ];

  it('finds the buttons of the tools', () => {
    expect(uses.filter((use) => use.component === 'CopyButton').length).toBeGreaterThan(20);
    expect(uses.filter((use) => use.component === 'DownloadButton').length).toBeGreaterThan(8);
  });

  for (const { locale, messages } of catalogs) {
    it(`every accessible name contains the visible word (${locale})`, () => {
      const keys: Use[] = [
        ...uses,
        // The timestamp table passes its row labels (`row.copy`) from these keys.
        ...Object.keys(messages)
          .filter((key) => key.startsWith('timestamp.copy.'))
          .map((key): Use => ({ component: 'CopyButton', key })),
      ];
      for (const { component, key } of keys) {
        const word = messages[component === 'CopyButton' ? 'tool.copy' : 'tool.download'];
        const name = messages[key];
        expect(typeof word, 'visible word').toBe('string');
        expect(typeof name, key).toBe('string');
        expect((name as string).toLowerCase(), `${key} (${locale})`).toContain(
          (word as string).toLowerCase(),
        );
      }
    });
  }
});
