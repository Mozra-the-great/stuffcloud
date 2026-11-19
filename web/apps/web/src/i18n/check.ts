import type { Locale } from './locales.ts';
import { PLACEHOLDER } from './translate.ts';
import type { Catalog, Message, PluralCategory } from './types.ts';

export type CatalogIssueKind =
  | 'missing-key'
  | 'extra-key'
  | 'empty'
  | 'syntax'
  | 'placeholders'
  | 'plural-forms'
  | 'plural-count';

export interface CatalogIssue {
  readonly kind: CatalogIssueKind;
  readonly locale: Locale;
  readonly key: string;
  readonly detail: string;
}

function forms(message: Message): readonly string[] {
  return typeof message === 'string' ? [message] : Object.values(message);
}

function placeholdersOf(text: string): ReadonlySet<string> {
  return new Set([...text.matchAll(PLACEHOLDER)].map((match) => match[1] ?? ''));
}

/** Placeholders of the fallback text (`other` for plural messages). */
function basePlaceholders(message: Message): ReadonlySet<string> {
  return placeholdersOf(typeof message === 'string' ? message : message.other);
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((item) => b.has(item));
}

function list(items: Iterable<string>): string {
  return [...items].sort().join(', ');
}

function checkMessage(
  locale: Locale,
  key: string,
  message: Message,
  reference: Message,
): CatalogIssue[] {
  const issues: CatalogIssue[] = [];
  const issue = (kind: CatalogIssueKind, detail: string): void => {
    issues.push({ kind, locale, key, detail });
  };

  for (const text of forms(message)) {
    if (text.trim() === '') {
      issue('empty', 'a form is empty');
    }
    // After removing the valid placeholders no brace may remain.
    if (/[{}]/.test(text.replace(PLACEHOLDER, ''))) {
      issue('syntax', `stray brace in ${JSON.stringify(text)}`);
    }
  }

  if (!sameSet(basePlaceholders(message), basePlaceholders(reference))) {
    issue(
      'placeholders',
      `has {${list(basePlaceholders(message))}}, the reference has {${list(basePlaceholders(reference))}}`,
    );
  }

  if (typeof message === 'string') {
    if (typeof reference !== 'string') {
      issue('plural-forms', 'the reference is a plural message, this one is plain text');
    }
    return issues;
  }

  if (typeof reference === 'string') {
    issue('plural-forms', 'the reference is plain text, this one is a plural message');
  }
  const expected: ReadonlySet<string> = new Set(
    new Intl.PluralRules(locale).resolvedOptions().pluralCategories,
  );
  const actual = new Set<string>(Object.keys(message));
  if (!sameSet(actual, expected)) {
    issue('plural-forms', `has ${list(actual)}, ${locale} needs ${list(expected)}`);
  }
  if (!placeholdersOf(message.other).has('count')) {
    issue('plural-count', 'the plural message does not use {count}');
  }
  for (const category of Object.keys(message) as PluralCategory[]) {
    const extra = [...placeholdersOf(message[category] ?? '')].filter(
      (name) => !basePlaceholders(message).has(name),
    );
    if (extra.length > 0) {
      issue('placeholders', `form ${category} adds {${list(extra)}}`);
    }
  }
  return issues;
}

/**
 * Compares every catalogue with the reference locale: same keys, no empty or malformed text,
 * the same placeholders, plural forms exactly as the CLDR rules of the locale need them.
 */
export function checkCatalogs(
  catalogs: Readonly<Record<Locale, Catalog>>,
  reference: Locale,
): CatalogIssue[] {
  const base = catalogs[reference];
  const issues: CatalogIssue[] = [];
  for (const [name, catalog] of Object.entries(catalogs) as [Locale, Catalog][]) {
    for (const key of Object.keys(base)) {
      if (!Object.hasOwn(catalog, key)) {
        issues.push({ kind: 'missing-key', locale: name, key, detail: `missing in ${name}` });
      }
    }
    for (const [key, message] of Object.entries(catalog)) {
      const referenceMessage = base[key];
      if (referenceMessage === undefined) {
        issues.push({ kind: 'extra-key', locale: name, key, detail: `not in ${reference}` });
      } else {
        issues.push(...checkMessage(name, key, message, referenceMessage));
      }
    }
  }
  return issues;
}

/** Keys whose quoted text appears in none of the sources (dead messages). */
export function findUnusedKeys(keys: readonly string[], sources: readonly string[]): string[] {
  return keys.filter(
    (key) =>
      !sources.some((source) =>
        [`'${key}'`, `"${key}"`, `\`${key}\``].some((quoted) => source.includes(quoted)),
      ),
  );
}

/** The literal keys passed to `t(...)` in a source file. */
export function findTranslationCalls(source: string): string[] {
  return [...source.matchAll(/(?<![\w.$])t\(\s*(['"`])([^'"`$]*)\1/g)].map(
    (match) => match[2] ?? '',
  );
}
