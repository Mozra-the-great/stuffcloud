import { ManifestError } from '@stuffcloud/tools';
import { describe, expect, it } from 'vitest';
import { TOOL_ENTRIES } from '../src/app/tool-entries.ts';
import { buildRegistry, type ManifestModules } from '../src/app/registry.ts';
import type { Locale } from '../src/i18n/locales.ts';
import { de } from '../src/i18n/messages/de.ts';
import { en } from '../src/i18n/messages/en.ts';
import type { Catalog } from '../src/i18n/types.ts';
import sample from './fixtures/sample-tool/manifest.ts';
import { SAMPLE_CATALOGS } from './fixtures/sample-tool/messages.ts';
import toolsConfig from '../tools.config.json';

type Input = Record<string, unknown>;
type Catalogs = Record<Locale, Catalog>;

/** A raw manifest for tool `id` (not checked by defineTool), with its three texts in the catalogues. */
function raw(id: string, change: Input = {}): Input {
  return {
    id,
    category: 'text',
    nameKey: `tool.${id}.name`,
    descriptionKey: `tool.${id}.description`,
    keywordsKey: `tool.${id}.keywords`,
    sticker: 'textops',
    runsIn: 'client',
    fileContent: 'stays-in-browser',
    requires: ['wasm'],
    budget: { scriptKb: 10, assetsKb: 0 },
    load: () => Promise.resolve({ default: () => undefined }),
    ...change,
  };
}

function texts(id: string): Catalogs {
  return {
    en: {
      ...en,
      [`tool.${id}.name`]: `${id} name`,
      [`tool.${id}.description`]: `${id} description`,
      [`tool.${id}.keywords`]: `${id} keywords`,
    },
    de: {
      ...de,
      [`tool.${id}.name`]: `${id} Name`,
      [`tool.${id}.description`]: `${id} Beschreibung`,
      [`tool.${id}.keywords`]: `${id} Stichworte`,
    },
  };
}

function modules(...inputs: Input[]): ManifestModules {
  return Object.fromEntries(
    inputs.map((input) => [`./${String(input['id'])}/manifest.ts`, { default: input }]),
  );
}

function catalogsFor(...ids: string[]): Catalogs {
  const all = ids.map((id) => texts(id));
  return {
    en: Object.assign({}, ...all.map((entry) => entry.en)) as Catalog,
    de: Object.assign({}, ...all.map((entry) => entry.de)) as Catalog,
  };
}

function issuesOf(action: () => unknown): ManifestError['issues'] {
  try {
    action();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ManifestError);
    return (error as ManifestError).issues;
  }
  throw new Error('expected the registry to throw');
}

describe('buildRegistry', () => {
  it('turns manifests into entries with the texts of every language resolved', () => {
    const { entries, disabled } = buildRegistry(modules(raw('alpha')), {
      catalogs: catalogsFor('alpha'),
    });
    expect(disabled).toEqual([]);
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry).toMatchObject({
      id: 'alpha',
      category: 'text',
      name: { en: 'alpha name', de: 'alpha Name' },
      description: { en: 'alpha description', de: 'alpha Beschreibung' },
      keywords: { en: 'alpha keywords', de: 'alpha Stichworte' },
      sticker: 'textops',
      requires: ['wasm'],
    });
    expect(typeof entry?.load).toBe('function');
  });

  it('works from the sample manifest alone', () => {
    const { entries } = buildRegistry(modules(sample as never), { catalogs: SAMPLE_CATALOGS });
    expect(entries.map((entry) => entry.id)).toEqual(['sample-tool']);
    expect(entries[0]?.name).toEqual({ en: 'Sample tool', de: 'Beispiel-Tool' });
  });

  it('orders entries by category, then id, not by file order', () => {
    const catalogs = catalogsFor('zeta', 'beta', 'alpha', 'omega');
    const { entries } = buildRegistry(
      modules(
        raw('zeta', { category: 'extra' }),
        raw('beta', { category: 'pdf' }),
        raw('alpha', { category: 'text' }),
        raw('omega', { category: 'pdf' }),
      ),
      { catalogs },
    );
    expect(entries.map((entry) => entry.id)).toEqual(['beta', 'omega', 'alpha', 'zeta']);
  });

  it('returns no entries for no manifests', () => {
    expect(buildRegistry({})).toEqual({ entries: [], disabled: [] });
  });

  it('puts the schema issues of a tool under its id', () => {
    const issues = issuesOf(() =>
      buildRegistry(modules(raw('alpha', { category: 'nope' })), {
        catalogs: catalogsFor('alpha'),
      }),
    );
    expect(issues.map((issue) => `${issue.path}:${issue.code}`)).toEqual([
      'alpha.category:invalid-category',
    ]);
  });

  it('rejects a duplicate id', () => {
    const issues = issuesOf(() =>
      buildRegistry(
        {
          './alpha/manifest.ts': { default: raw('alpha') },
          './beta/manifest.ts': { default: raw('alpha') },
        },
        { catalogs: catalogsFor('alpha') },
      ),
    );
    const codes = issues.map((issue) => issue.code);
    expect(codes).toContain('duplicate-id');
    expect(codes).toContain('invalid-id');
  });

  it('requires the id to equal the directory', () => {
    const issues = issuesOf(() =>
      buildRegistry(
        { './folder/manifest.ts': { default: raw('alpha') } },
        { catalogs: catalogsFor('alpha') },
      ),
    );
    expect(issues).toEqual([
      {
        path: 'folder',
        code: 'invalid-id',
        message: 'the id "alpha" must equal the directory name "folder"',
      },
    ]);
  });

  it.each([
    ['null', null],
    ['a string', 'alpha'],
  ])('reports a default export that is %s without throwing a TypeError', (_name, value) => {
    const issues = issuesOf(() => buildRegistry({ './alpha/manifest.ts': { default: value } }));
    expect(issues.some((issue) => issue.path === 'alpha' && issue.code === 'invalid-id')).toBe(
      true,
    );
  });

  it('requires a default export', () => {
    const issues = issuesOf(() => buildRegistry({ './alpha/manifest.ts': {} }));
    expect(issues).toEqual([
      {
        path: 'alpha',
        code: 'missing-property',
        message: 'manifest.ts must export the manifest as its default export (defineTool)',
      },
    ]);
    const named = issuesOf(() => buildRegistry({ './alpha/manifest.ts': { default: undefined } }));
    expect(named[0]?.code).toBe('missing-property');
  });

  it('refuses a manifest outside src/tools/<id>/manifest.ts', () => {
    const issues = issuesOf(() => buildRegistry({ './alpha.ts': { default: raw('alpha') } }));
    expect(issues).toEqual([
      {
        path: './alpha.ts',
        code: 'invalid-id',
        message: 'a manifest must be at src/tools/<id>/manifest.ts',
      },
    ]);
  });

  it('accepts the path the Vite glob produces', () => {
    const { entries } = buildRegistry(
      { '../tools/alpha/manifest.ts': { default: raw('alpha') } },
      { catalogs: catalogsFor('alpha') },
    );
    expect(entries.map((entry) => entry.id)).toEqual(['alpha']);
  });

  it('collects the problems of several tools at once', () => {
    const issues = issuesOf(() =>
      buildRegistry(
        {
          ...modules(raw('alpha', { sticker: 'nope' })),
          ...modules(raw('beta', { runsIn: 'server' })),
          './gamma/manifest.ts': {},
        },
        { catalogs: catalogsFor('alpha', 'beta') },
      ),
    );
    expect(issues.map((issue) => issue.code).toSorted()).toEqual([
      'invalid-sticker',
      'missing-property',
      'server-not-allowed',
    ]);
  });

  describe('texts', () => {
    it.each(['nameKey', 'descriptionKey', 'keywordsKey'] as const)(
      'fails when the %s has no text in a catalogue, and names the language',
      (field) => {
        const key = `tool.alpha.${field.replace('Key', '')}`;
        for (const locale of ['en', 'de'] as const) {
          const catalogs = catalogsFor('alpha');
          const copy: Input = { ...catalogs[locale] };
          Reflect.deleteProperty(copy, key);
          const issues = issuesOf(() =>
            buildRegistry(modules(raw('alpha')), {
              catalogs: { ...catalogs, [locale]: copy as Catalog },
            }),
          );
          expect(issues).toEqual([
            {
              path: `alpha.${field}`,
              code: 'missing-text',
              message: `"${key}" has no plain text in the ${locale} catalogue`,
            },
          ]);
        }
      },
    );

    it('fails for an empty text and for a plural message (a name is plain text)', () => {
      const empty = issuesOf(() =>
        buildRegistry(modules(raw('alpha')), {
          catalogs: {
            ...catalogsFor('alpha'),
            en: { ...catalogsFor('alpha').en, 'tool.alpha.name': '   ' },
          },
        }),
      );
      expect(empty.map((issue) => issue.code)).toEqual(['missing-text']);
      const plural = issuesOf(() =>
        buildRegistry(modules(raw('alpha')), {
          catalogs: {
            ...catalogsFor('alpha'),
            de: {
              ...catalogsFor('alpha').de,
              'tool.alpha.name': { one: 'a', other: 'b' },
            },
          },
        }),
      );
      expect(plural.map((issue) => issue.code)).toEqual(['missing-text']);
    });

    it('does not take an inherited property of the catalogue for a text', () => {
      const catalogs = catalogsFor('alpha');
      const inherited = Object.create({ 'tool.alpha.name': 'inherited' }) as Input;
      Object.assign(inherited, { ...catalogs.en });
      Reflect.deleteProperty(inherited, 'tool.alpha.name');
      const issues = issuesOf(() =>
        buildRegistry(modules(raw('alpha')), {
          catalogs: { ...catalogs, en: inherited as Catalog },
        }),
      );
      expect(issues.map((issue) => issue.code)).toEqual(['missing-text']);
    });

    it('checks the real catalogues by default', () => {
      expect(() => buildRegistry(modules(raw('alpha')))).toThrow(ManifestError);
    });
  });

  describe('tools.config.json', () => {
    const catalogs = catalogsFor('alpha', 'beta');

    it('leaves a disabled tool out of the entries and lists it', () => {
      const result = buildRegistry(modules(raw('alpha'), raw('beta')), {
        catalogs,
        config: { disabled: ['beta'] },
      });
      expect(result.entries.map((entry) => entry.id)).toEqual(['alpha']);
      expect(result.disabled).toEqual(['beta']);
    });

    it('can disable everything', () => {
      const result = buildRegistry(modules(raw('alpha'), raw('beta')), {
        catalogs,
        config: { disabled: ['alpha', 'beta'] },
      });
      expect(result.entries).toEqual([]);
    });

    it('fails on an id that is not a tool (a typo must not leave a tool enabled)', () => {
      expect(() =>
        buildRegistry(modules(raw('alpha')), { catalogs, config: { disabled: ['alpah'] } }),
      ).toThrow('tools.config.json is invalid:\n  - disabled[0]: there is no tool "alpah"');
    });

    it('fails on a malformed file', () => {
      expect(() => buildRegistry(modules(raw('alpha')), { catalogs, config: [] })).toThrow(
        'tools.config.json is invalid',
      );
    });

    it('treats a missing config as nothing disabled', () => {
      expect(buildRegistry(modules(raw('alpha')), { catalogs }).disabled).toEqual([]);
    });

    it('does not report config problems when the manifests are already broken', () => {
      const issues = issuesOf(() =>
        buildRegistry(modules(raw('alpha', { category: 'nope' })), {
          catalogs,
          config: { disabled: ['ghost'] },
        }),
      );
      expect(issues.map((issue) => issue.code)).toEqual(['invalid-category']);
    });
  });
});

describe('the shipped registry', () => {
  it('is the tool list of this build, built from src/tools and tools.config.json', () => {
    expect(Array.isArray(TOOL_ENTRIES)).toBe(true);
    for (const entry of TOOL_ENTRIES) {
      expect(entry.name.en).not.toBe('');
      expect(entry.name.de).not.toBe('');
    }
  });

  it('ships a configuration that parses (no tool disabled by default)', () => {
    expect(toolsConfig).toEqual({ disabled: [] });
  });
});
