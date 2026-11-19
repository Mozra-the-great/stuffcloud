import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Plugin } from 'vite';
import { buildRegistry } from '../src/app/registry.ts';
import type { Locale } from '../src/i18n/locales.ts';
import type { Catalog } from '../src/i18n/types.ts';

// This file runs in Node (type stripping) as well as inside the Vite config: plain TypeScript
// modules only, no Svelte runes, no `$lib`-style aliases.

/** The default app root: `web/apps/web`. */
export const APP_ROOT = resolve(import.meta.dirname, '..');

/**
 * Checks every tool of the app at `root` the way the app itself will read it: each directory
 * under `src/tools` has a `manifest.ts` whose default export passes the schema, ids match the
 * directories and each other, every text exists in both catalogues, and `tools.config.json` is
 * valid. Returns the problems (an empty list means all is well); never throws for a bad tool.
 */
export async function checkTools(root: string = APP_ROOT): Promise<readonly string[]> {
  const problems: string[] = [];
  const toolsDir = join(root, 'src', 'tools');
  if (!existsSync(toolsDir)) {
    return [`${toolsDir}: the tools directory does not exist`];
  }

  const modules: Record<string, { default?: unknown }> = {};
  const directories = readdirSync(toolsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();
  for (const directory of directories) {
    const manifest = join(toolsDir, directory, 'manifest.ts');
    if (!existsSync(manifest)) {
      problems.push(`src/tools/${directory}: manifest.ts is missing`);
      continue;
    }
    try {
      modules[`./${directory}/manifest.ts`] = (await import(
        /* @vite-ignore */ pathToFileURL(manifest).href
      )) as { default?: unknown };
    } catch (error: unknown) {
      problems.push(`src/tools/${directory}/manifest.ts: ${messageOf(error)}`);
    }
  }

  const catalogs = await readCatalogs(root, problems);
  const config = readConfig(root, problems);
  if (problems.length > 0 || catalogs === undefined) {
    return problems;
  }
  try {
    buildRegistry(modules, { catalogs, config });
  } catch (error: unknown) {
    problems.push(messageOf(error));
  }
  return problems;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readCatalogs(
  root: string,
  problems: string[],
): Promise<Readonly<Record<Locale, Catalog>> | undefined> {
  try {
    const messages = join(root, 'src', 'i18n', 'messages');
    const [de, en] = (await Promise.all([
      import(/* @vite-ignore */ pathToFileURL(join(messages, 'de.ts')).href),
      import(/* @vite-ignore */ pathToFileURL(join(messages, 'en.ts')).href),
    ])) as [{ de: Catalog }, { en: Catalog }];
    return { de: de.de, en: en.en };
  } catch (error: unknown) {
    problems.push(`src/i18n/messages: ${messageOf(error)}`);
    return undefined;
  }
}

function readConfig(root: string, problems: string[]): unknown {
  const path = join(root, 'tools.config.json');
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error: unknown) {
    problems.push(`tools.config.json: ${messageOf(error)}`);
    return undefined;
  }
}

/** The text printed (and thrown) when tools are broken. */
export function formatProblems(problems: readonly string[]): string {
  return `The tool registry is broken:\n${problems.map((problem) => `- ${problem}`).join('\n')}`;
}

/**
 * Vite plugin: `vite build` (and the dev server at start) fails when a tool manifest breaks the
 * schema, so a bad manifest can never reach a deployed bundle.
 */
export function toolManifestCheck(root: string = APP_ROOT): Plugin {
  return {
    name: 'stuffcloud-tool-manifests',
    async buildStart(): Promise<void> {
      const problems = await checkTools(root);
      if (problems.length > 0) {
        throw new Error(formatProblems(problems));
      }
    },
  };
}

export interface CheckIo {
  readonly out: (message: string) => void;
  readonly err: (message: string) => void;
}

/** CLI logic: `check-tools [--root <dir>]`; returns the exit code (0 fine, 1 broken, 2 usage). */
export async function runCheckCli(args: readonly string[], io: CheckIo): Promise<number> {
  let root = APP_ROOT;
  if (args.length > 0) {
    if (args[0] !== '--root' || args.length !== 2 || args[1] === undefined || args[1] === '') {
      io.err('usage: check-tools [--root <app directory>]');
      return 2;
    }
    root = resolve(args[1]);
  }
  const problems = await checkTools(root);
  if (problems.length > 0) {
    io.err(formatProblems(problems));
    return 1;
  }
  io.out('tool manifests are valid');
  return 0;
}
