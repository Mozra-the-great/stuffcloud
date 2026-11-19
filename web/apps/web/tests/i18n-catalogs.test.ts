import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parse } from 'svelte/compiler';
import { describe, expect, it } from 'vitest';
import {
  checkCatalogs,
  findTranslationCalls,
  findUnusedKeys,
  type CatalogIssue,
} from '../src/i18n/check.ts';
import { CATALOGS } from '../src/i18n/i18n.svelte.ts';
import type { Locale } from '../src/i18n/locales.ts';
import { de } from '../src/i18n/messages/de.ts';
import { en } from '../src/i18n/messages/en.ts';
import type { Catalog } from '../src/i18n/types.ts';
import { appRoot } from './helpers.ts';

const srcRoot = join(appRoot, 'src');

function sourceFiles(dir: string, extensions: readonly string[]): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path, extensions);
    }
    return extensions.some((extension) => entry.name.endsWith(extension)) ? [path] : [];
  });
}

/** App code that uses messages: everything except the catalogues, the base components and the gallery. */
function isAppSource(path: string): boolean {
  const parts = relative(srcRoot, path).split(sep);
  return parts[0] !== 'gallery' && parts[0] !== 'ui' && parts[1] !== 'messages';
}

const appSources = sourceFiles(srcRoot, ['.ts', '.svelte']).filter(isAppSource);

function kinds(issues: readonly CatalogIssue[]): string[] {
  return issues.map((issue) => `${issue.kind}:${issue.locale}:${issue.key}`);
}

/**
 * The CI check of issue #11: the shipped catalogues are complete and consistent. A failure
 * names the key and the locale. The cases below prove that each rule actually fails.
 */
describe('shipped catalogues', () => {
  it('have the same keys in every language and consistent messages', () => {
    expect(checkCatalogs(CATALOGS, 'en')).toEqual([]);
    expect(Object.keys(de).toSorted()).toEqual(Object.keys(en).toSorted());
  });

  it('have no unused key: every key is referenced by app code', () => {
    const sources = appSources.map((path) => readFileSync(path, 'utf8'));
    expect(findUnusedKeys(Object.keys(en), sources)).toEqual([]);
  });

  it('are only asked for keys that exist: every literal t(...) call resolves', () => {
    const missing: string[] = [];
    for (const path of appSources) {
      for (const key of findTranslationCalls(readFileSync(path, 'utf8'))) {
        if (!Object.hasOwn(en, key)) {
          missing.push(`${relative(srcRoot, path)}: ${key}`);
        }
      }
    }
    expect(missing).toEqual([]);
    expect(appSources.length).toBeGreaterThan(10);
  });
});

describe('no hard-coded UI strings in the app shell', () => {
  const ATTRIBUTES = new Set([
    'aria-label',
    'aria-description',
    'aria-roledescription',
    'title',
    'alt',
    'placeholder',
    'label',
  ]);

  type Node = Readonly<Record<string, unknown>>;

  function violations(source: string): string[] {
    const found: string[] = [];
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (typeof value !== 'object' || value === null) {
        return;
      }
      const node = value as Node;
      if (
        node['type'] === 'Text' &&
        typeof node['data'] === 'string' &&
        /\p{L}/u.test(node['data'])
      ) {
        found.push(`text ${JSON.stringify(node['data'].trim())}`);
      }
      if (node['type'] === 'Attribute' && ATTRIBUTES.has(String(node['name']))) {
        const parts = Array.isArray(node['value']) ? (node['value'] as Node[]) : [];
        for (const part of parts) {
          if (part['type'] === 'Text' && /\p{L}/u.test(String(part['data']))) {
            found.push(`${String(node['name'])}=${JSON.stringify(part['data'])}`);
          }
        }
      }
      if (node['type'] === 'Attribute') {
        // Values are plain attribute text (`class="frame"`), not rendered copy; checked above.
        return;
      }
      Object.values(node).forEach(visit);
    };
    visit(parse(source, { modern: true }).fragment);
    return found;
  }

  it('finds literal text and literal accessible names (the check itself works)', () => {
    expect(violations('<p>Hello</p>')).toEqual(['text "Hello"']);
    expect(violations('<button aria-label="Close">x</button>')).toContain('aria-label="Close"');
    expect(violations('<img alt="Logo" />')).toEqual(['alt="Logo"']);
    expect(violations('<p>{t("a")} · {name}</p>')).toEqual([]);
    expect(violations('<input aria-label={t("a")} />')).toEqual([]);
  });

  const components = sourceFiles(join(srcRoot, 'app'), ['.svelte']);

  it('covers the shell components', () => {
    expect(components.length).toBeGreaterThanOrEqual(10);
  });

  it.each(components.map((path) => [relative(srcRoot, path), path] as const))(
    '%s has only translated text',
    (_name, path) => {
      expect(violations(readFileSync(path, 'utf8'))).toEqual([]);
    },
  );
});

describe('checkCatalogs rules', () => {
  const base: Record<Locale, Catalog> = {
    en: { plain: 'Hello {name}', plural: { one: '{count} file', other: '{count} files' } },
    de: { plain: 'Hallo {name}', plural: { one: '{count} Datei', other: '{count} Dateien' } },
  };

  function withDe(overrides: Catalog): Record<Locale, Catalog> {
    return { en: base.en, de: { ...base.de, ...overrides } };
  }

  it('accepts a consistent pair', () => {
    expect(checkCatalogs(base, 'en')).toEqual([]);
  });

  it('reports a key missing in a language', () => {
    const rest = Object.fromEntries(Object.entries(base.de).filter(([key]) => key !== 'plural'));
    expect(kinds(checkCatalogs({ en: base.en, de: rest }, 'en'))).toEqual([
      'missing-key:de:plural',
    ]);
  });

  it('reports a key that only a translation has', () => {
    expect(kinds(checkCatalogs(withDe({ stray: 'x' }), 'en'))).toEqual(['extra-key:de:stray']);
  });

  it('reports an empty text, also in a plural form', () => {
    expect(kinds(checkCatalogs(withDe({ plain: '  ' }), 'en'))).toContain('empty:de:plain');
    expect(
      kinds(checkCatalogs(withDe({ plural: { one: '', other: '{count} Dateien' } }), 'en')),
    ).toContain('empty:de:plural');
  });

  it('reports stray braces and malformed placeholders', () => {
    expect(kinds(checkCatalogs(withDe({ plain: 'Hallo {name' }), 'en'))).toContain(
      'syntax:de:plain',
    );
    expect(kinds(checkCatalogs(withDe({ plain: 'Hallo {name} }' }), 'en'))).toContain(
      'syntax:de:plain',
    );
    expect(kinds(checkCatalogs(withDe({ plain: 'Hallo {1}' }), 'en'))).toContain('syntax:de:plain');
  });

  it('reports a placeholder that is missing, renamed or extra', () => {
    expect(kinds(checkCatalogs(withDe({ plain: 'Hallo' }), 'en'))).toEqual([
      'placeholders:de:plain',
    ]);
    expect(kinds(checkCatalogs(withDe({ plain: 'Hallo {who}' }), 'en'))).toEqual([
      'placeholders:de:plain',
    ]);
    expect(kinds(checkCatalogs(withDe({ plain: 'Hallo {name} {more}' }), 'en'))).toEqual([
      'placeholders:de:plain',
    ]);
  });

  it('reports plural forms that do not match the language rules', () => {
    expect(kinds(checkCatalogs(withDe({ plural: { other: '{count} Dateien' } }), 'en'))).toEqual([
      'plural-forms:de:plural',
    ]);
    expect(
      kinds(
        checkCatalogs(
          withDe({ plural: { one: '{count} Datei', few: '{count} x', other: '{count} Dateien' } }),
          'en',
        ),
      ),
    ).toEqual(['plural-forms:de:plural']);
  });

  it('reports a plural message that does not use {count}', () => {
    const issues = checkCatalogs(withDe({ plural: { one: 'eine Datei', other: 'Dateien' } }), 'en');
    expect(kinds(issues)).toContain('plural-count:de:plural');
  });

  it('reports a plural form that adds a placeholder the fallback text lacks', () => {
    const issues = checkCatalogs(
      withDe({ plural: { one: '{count} {unit}', other: '{count} Dateien' } }),
      'en',
    );
    expect(issues.map((issue) => issue.detail)).toContain('form one adds {unit}');
  });

  it('reports plain text where the reference is plural, and the other way round', () => {
    expect(kinds(checkCatalogs(withDe({ plural: 'Dateien {count}' }), 'en'))).toContain(
      'plural-forms:de:plural',
    );
    expect(
      kinds(
        checkCatalogs(
          withDe({ plain: { one: 'a {name} {count}', other: 'b {name} {count}' } }),
          'en',
        ),
      ),
    ).toContain('plural-forms:de:plain');
  });
});

describe('source scanning', () => {
  it('finds unused keys in any quote style', () => {
    const sources = [`t('a.b')`, `t("c.d")`, 'const k = `e.f`;'];
    expect(findUnusedKeys(['a.b', 'c.d', 'e.f', 'g.h'], sources)).toEqual(['g.h']);
  });

  it('does not count a key that is only a substring of another', () => {
    expect(findUnusedKeys(['a'], [`t('a.b')`])).toEqual(['a']);
  });

  it('finds literal t() calls but not other functions ending in t', () => {
    const source = `t('a.b'); t( "c.d" ); split('x.y'); obj.t('no'); t(variable); t(\`e.f\`)`;
    expect(findTranslationCalls(source)).toEqual(['a.b', 'c.d', 'e.f']);
  });
});
