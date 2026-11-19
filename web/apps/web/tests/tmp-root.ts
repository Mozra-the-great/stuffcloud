import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appRoot } from './helpers.ts';

/**
 * A throw-away app tree for tests of the build tooling: the real `define.ts`, the real
 * catalogues and an empty `tools.config.json`. It lives inside the app directory (not in the
 * system temp folder) so that `@stuffcloud/tools` resolves from it like from the real tree.
 * The name starts with `.tmp-`, which git, prettier and eslint ignore.
 */
export interface TempRoot {
  readonly root: string;
  /** Writes `content` to `path` (relative to the tree), creating directories; a manifest also gets a stub `Tool.svelte`. */
  readonly write: (path: string, content: string) => void;
  readonly remove: () => void;
}

const COPIED = ['src/tools/define.ts', 'src/i18n/messages/en.ts', 'src/i18n/messages/de.ts'];

export function createTempRoot(): TempRoot {
  const root = mkdtempSync(join(appRoot, '.tmp-test-'));
  for (const file of COPIED) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(join(appRoot, file), join(root, file));
  }
  const write = (path: string, content: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
    if (path.endsWith('/manifest.ts')) {
      // The page the manifest loads; Vite resolves `import('./Tool.svelte')` when it transforms the manifest.
      writeFileSync(join(dirname(join(root, path)), 'Tool.svelte'), '<h1>tool</h1>');
    }
  };
  write('tools.config.json', '{ "disabled": [] }\n');
  return {
    root,
    write,
    remove: (): void => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A manifest.ts for tool `id`; `change` replaces lines (by property name) with other source. */
export function manifestSource(id: string, change: Readonly<Record<string, string>> = {}): string {
  const fields: Record<string, string> = {
    id: `'${id}'`,
    category: "'text'",
    nameKey: `'tool.${id}.name'`,
    descriptionKey: `'tool.${id}.description'`,
    keywordsKey: `'tool.${id}.keywords'`,
    sticker: "'textops'",
    runsIn: "'client'",
    fileContent: "'stays-in-browser'",
    requires: '[]',
    budget: '{ scriptKb: 10, assetsKb: 0 }',
    load: "() => import('./Tool.svelte')",
    ...change,
  };
  const body = Object.entries(fields)
    .map(([key, value]) => `  ${key}: ${value},`)
    .join('\n');
  return `import { defineTool } from '../define.ts';\n\nexport default defineTool({\n${body}\n} as never);\n`;
}

/** Adds the three texts of tool `id` to both catalogues of the tree (before the closing line). */
export function addTexts(tree: TempRoot, id: string, skip: readonly string[] = []): void {
  for (const [locale, closing] of [
    ['en', '\n} as const satisfies'],
    ['de', '\n};'],
  ] as const) {
    const path = `src/i18n/messages/${locale}.ts`;
    const source = dirSource(tree, path);
    const at = source.lastIndexOf(closing);
    const lines = ['name', 'description', 'keywords']
      .map((field) => `tool.${id}.${field}`)
      .filter((key) => !skip.includes(`${locale}:${key}`))
      .map((key) => `  '${key}': '${key} ${locale}',`)
      .join('\n');
    tree.write(path, `${source.slice(0, at)}\n${lines}${source.slice(at)}`);
  }
}

function dirSource(tree: TempRoot, path: string): string {
  return readFileSync(join(tree.root, path), 'utf8');
}
