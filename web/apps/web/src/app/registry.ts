import {
  formatIssues,
  ManifestError,
  parseToolSet,
  parseToolsConfig,
  TOOL_CATEGORIES,
  type ManifestIssue,
  type ToolManifest,
} from '@stuffcloud/tools';
import { LOCALES, type Locale } from '../i18n/locales.ts';
import { de } from '../i18n/messages/de.ts';
import { en, type MessageKey } from '../i18n/messages/en.ts';
import type { Catalog } from '../i18n/types.ts';
import type { RouteModule } from './router/router.svelte.ts';
import type { ToolEntry } from './tools.ts';

/** A tool manifest as the app uses it: message keys of the catalogue, a route module to load. */
export type AppToolManifest = ToolManifest<MessageKey, RouteModule>;

/** `import.meta.glob` result: path of `<id>/manifest.ts` to its module. */
export type ManifestModules = Readonly<Record<string, { readonly default?: unknown }>>;

export interface RegistryOptions {
  /** Defaults to the shipped catalogues. */
  readonly catalogs?: Readonly<Record<Locale, Catalog>>;
  /** Contents of `tools.config.json`. Defaults to nothing disabled. */
  readonly config?: unknown;
}

export interface ToolRegistry {
  /** Every tool that is switched on: this is what navigation, search and routing are built from. */
  readonly entries: readonly ToolEntry[];
  /** Ids switched off by the configuration; they have no entry, no route and no search hit. */
  readonly disabled: readonly string[];
}

// Plain modules only (no Svelte runes): `scripts/check-tools.ts` runs this file in Node.
const SHIPPED_CATALOGS: Readonly<Record<Locale, Catalog>> = { de, en };

const MANIFEST_PATH = /(?:^|\/)([^/]+)\/manifest\.ts$/;

function textOf(catalogs: Readonly<Record<Locale, Catalog>>, locale: Locale, key: string): string {
  const message = Object.hasOwn(catalogs[locale], key) ? catalogs[locale][key] : undefined;
  return typeof message === 'string' ? message : '';
}

function resolveTexts(
  manifest: AppToolManifest,
  catalogs: Readonly<Record<Locale, Catalog>>,
  issues: ManifestIssue[],
): void {
  for (const field of ['nameKey', 'descriptionKey', 'keywordsKey'] as const) {
    for (const locale of LOCALES) {
      if (textOf(catalogs, locale, manifest[field]).trim() === '') {
        issues.push({
          path: `${manifest.id}.${field}`,
          code: 'missing-text',
          message: `${JSON.stringify(manifest[field])} has no plain text in the ${locale} catalogue`,
        });
      }
    }
  }
}

function localized(
  catalogs: Readonly<Record<Locale, Catalog>>,
  key: string,
): Readonly<Record<Locale, string>> {
  return {
    de: textOf(catalogs, 'de', key),
    en: textOf(catalogs, 'en', key),
  };
}

/**
 * Builds the tool list of the app from the manifest modules (`src/tools/<id>/manifest.ts`):
 * validates every manifest and the set, checks that each text exists in every catalogue,
 * applies `tools.config.json` and resolves the texts for every language. Throws a
 * {@link ManifestError} that lists all problems; the app does not start with a broken tool,
 * and the build fails the same way (`scripts/check-tools.ts`).
 */
export function buildRegistry(
  modules: ManifestModules,
  options: RegistryOptions = {},
): ToolRegistry {
  const catalogs = options.catalogs ?? SHIPPED_CATALOGS;
  const issues: ManifestIssue[] = [];
  const inputs: unknown[] = [];

  for (const [path, module] of Object.entries(modules).toSorted(([a], [b]) => a.localeCompare(b))) {
    const directory = MANIFEST_PATH.exec(path)?.[1];
    if (directory === undefined) {
      issues.push({
        path,
        code: 'invalid-id',
        message: 'a manifest must be at src/tools/<id>/manifest.ts',
      });
      continue;
    }
    if (!Object.hasOwn(module, 'default') || module.default === undefined) {
      issues.push({
        path: directory,
        code: 'missing-property',
        message: 'manifest.ts must export the manifest as its default export (defineTool)',
      });
      continue;
    }
    const raw: unknown = module.default;
    const id =
      typeof raw === 'object' && raw !== null ? (raw as { readonly id?: unknown }).id : undefined;
    if (id !== directory) {
      issues.push({
        path: directory,
        code: 'invalid-id',
        message: `the id ${JSON.stringify(id)} must equal the directory name ${JSON.stringify(directory)}`,
      });
    }
    inputs.push(module.default);
  }

  const parsed = parseToolSet<MessageKey, RouteModule>(inputs, TOOL_CATEGORIES);
  if (!parsed.ok) {
    issues.push(...parsed.issues);
  } else {
    for (const manifest of parsed.manifests) {
      resolveTexts(manifest, catalogs, issues);
    }
  }
  if (issues.length > 0 || !parsed.ok) {
    throw new ManifestError('the tool registry', issues);
  }

  const config = parseToolsConfig(
    options.config ?? { disabled: [] },
    new Set(parsed.manifests.map((manifest) => manifest.id)),
  );
  if (!config.ok) {
    throw new Error(
      `tools.config.json is invalid:\n${formatIssues(
        config.issues.map((message) => ({ path: '', code: 'invalid-id', message })),
      )}`,
    );
  }
  const disabled = new Set<string>(config.value.disabled);

  const entries = parsed.manifests
    .filter((manifest) => !disabled.has(manifest.id))
    .map((manifest): ToolEntry => ({
      id: manifest.id,
      category: manifest.category,
      name: localized(catalogs, manifest.nameKey),
      description: localized(catalogs, manifest.descriptionKey),
      keywords: localized(catalogs, manifest.keywordsKey),
      sticker: manifest.sticker,
      requires: manifest.requires,
      load: manifest.load,
    }));
  return { entries, disabled: [...disabled] };
}
