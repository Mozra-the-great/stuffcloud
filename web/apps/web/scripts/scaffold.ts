import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import type * as Prettier from 'prettier';
import {
  isStickerName,
  isToolCategory,
  parseToolId,
  STICKER_NAMES,
  TOOL_CATEGORIES,
  toolTextKey,
  type StickerName,
  type ToolCategory,
} from '@stuffcloud/tools';

// Loaded with Node's own resolution: the test runner's `browser` condition would pick Prettier's
// standalone build, which has no `resolveConfig`.
const { format, resolveConfig } = createRequire(import.meta.url)('prettier') as typeof Prettier;

/** The default app root: `web/apps/web`. */
const APP_ROOT = resolve(import.meta.dirname, '..');

export interface ScaffoldOptions {
  readonly id: string;
  readonly category: ToolCategory;
  readonly sticker: StickerName;
  /** English name; the German catalogue starts with the same text. */
  readonly name: string;
  /** Also create the worker, the task and the pool (`requires: ['worker']`). */
  readonly worker: boolean;
}

export type ScaffoldArgs =
  | { readonly ok: true; readonly options: ScaffoldOptions }
  | { readonly ok: false; readonly error: string };

export const USAGE =
  'usage: pnpm new-tool <id> [--category <category>] [--sticker <sticker>] [--name "<English name>"] [--worker]';

const NAME_MAX_LENGTH = 40;

/** `merge-pdf` becomes `Merge pdf`: a starting point the author edits. */
export function defaultName(id: string): string {
  const words = id.split('-').join(' ');
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/** Parses the command line; the first message of everything wrong is the error. */
export function parseScaffoldArgs(args: readonly string[]): ScaffoldArgs {
  let id: string | undefined;
  let category = 'extra';
  let sticker = 'shield';
  let name: string | undefined;
  let worker = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    const value = (): string | undefined => {
      index += 1;
      return args[index];
    };
    if (arg === '--worker') {
      worker = true;
    } else if (arg === '--category' || arg === '--sticker' || arg === '--name') {
      const given = value();
      if (given === undefined || given.startsWith('--')) {
        return { ok: false, error: `${arg} needs a value` };
      }
      if (arg === '--category') {
        category = given;
      } else if (arg === '--sticker') {
        sticker = given;
      } else {
        name = given;
      }
    } else if (arg.startsWith('--')) {
      return { ok: false, error: `unknown option ${arg}` };
    } else if (id === undefined) {
      id = arg;
    } else {
      return { ok: false, error: `unexpected argument ${JSON.stringify(arg)}` };
    }
  }
  if (id === undefined) {
    return { ok: false, error: 'the tool id is missing' };
  }
  const parsed = parseToolId(id);
  if (!parsed.ok) {
    return {
      ok: false,
      error: `${JSON.stringify(id)} is not a valid tool id (${parsed.error}): lowercase words joined by hyphens, at most 48 characters`,
    };
  }
  if (!isToolCategory(category)) {
    return {
      ok: false,
      error: `${JSON.stringify(category)} is not a category (${TOOL_CATEGORIES.join(', ')})`,
    };
  }
  if (!isStickerName(sticker)) {
    return {
      ok: false,
      error: `${JSON.stringify(sticker)} is not a sticker (${STICKER_NAMES.join(', ')})`,
    };
  }
  const text = (name ?? defaultName(parsed.value)).trim();
  if (text === '' || text.length > NAME_MAX_LENGTH || /[{}\p{Cc}]/u.test(text)) {
    return {
      ok: false,
      error: `the name must be 1 to ${String(NAME_MAX_LENGTH)} characters without braces or control characters`,
    };
  }
  return { ok: true, options: { id: parsed.value, category, sticker, name: text, worker } };
}

/** A single-quoted TypeScript string literal. */
export function quote(text: string): string {
  return `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

export interface Rendered {
  /** Path (relative to the app root) to file content, before formatting. */
  readonly files: Readonly<Record<string, string>>;
  /** Lines to add to both catalogues (the German ones start as the English text). */
  readonly messages: readonly (readonly [key: string, text: string])[];
}

/** What a new tool consists of. Pure: nothing is written here. */
export function renderTool(options: ScaffoldOptions): Rendered {
  const { id, category, sticker, name, worker } = options;
  const dir = `src/tools/${id}`;
  const files: Record<string, string> = {
    [`${dir}/manifest.ts`]: `import { defineTool } from '../define.ts';

export default defineTool({
  id: ${quote(id)},
  category: ${quote(category)},
  nameKey: ${quote(toolTextKey(id, 'name'))},
  descriptionKey: ${quote(toolTextKey(id, 'description'))},
  keywordsKey: ${quote(toolTextKey(id, 'keywords'))},
  sticker: ${quote(sticker)},
  runsIn: 'client',
  fileContent: 'stays-in-browser',
  requires: ${worker ? "['worker']" : '[]'},
  budget: { scriptKb: 50, assetsKb: 0 },
  load: () => import('./Tool.svelte'),
});
`,
    [`${dir}/Tool.svelte`]: `<script lang="ts">
  import ToolFrame from '../../app/ToolFrame.svelte';
</script>

<ToolFrame id=${JSON.stringify(id)} />
`,
    [`tests/tools/${id}.test.ts`]: renderTest(options),
    [`e2e/specs/${id}.spec.ts`]: renderSpec(options),
  };
  if (worker) {
    files[`${dir}/task.ts`] = `import type { TaskContext } from '@stuffcloud/tools';

export interface Input {
  readonly text: string;
}

export type Output = string;

/** The work of the tool. It runs in the worker, so it must not touch the DOM. */
export function runTask(input: Input, { progress }: TaskContext): Output {
  progress(1, 1);
  return input.text;
}
`;
    files[`${dir}/worker.ts`] = `import { serveWorker } from '@stuffcloud/tools';
import { runTask } from './task.ts';

serveWorker(runTask);
`;
    files[`${dir}/pool.ts`] =
      `import { createWorkerPool, type WorkerPool } from '@stuffcloud/tools';
import type { Input, Output } from './task.ts';

/** Starts the pool when the tool needs it; call \`terminate()\` when the page goes away. */
export function createPool(): WorkerPool<Input, Output> {
  return createWorkerPool<Input, Output>({
    create: () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
  });
}
`;
    files[`tests/tools/${id}.worker.test.ts`] = `import { describe, expect, it, vi } from 'vitest';
import { createPool } from '../../src/tools/${id}/pool.ts';
import { runTask } from '../../src/tools/${id}/task.ts';

describe(${quote(`${id} worker`)}, () => {
  it('reports its progress and returns the result', () => {
    const progress = vi.fn();
    expect(runTask({ text: 'hello' }, { progress })).toBe('hello');
    expect(progress).toHaveBeenCalledWith(1, 1);
  });

  it('starts its workers from worker.ts as modules', () => {
    const created: { url: URL; options: WorkerOptions | undefined }[] = [];
    vi.stubGlobal(
      'Worker',
      class FakeWorker {
        readonly postMessage = vi.fn();
        readonly terminate = vi.fn();
        readonly addEventListener = vi.fn();
        constructor(url: URL, options?: WorkerOptions) {
          created.push({ url, options });
        }
      },
    );
    const pool = createPool();
    void pool.run({ text: 'x' }).catch(() => undefined);
    pool.terminate();
    vi.unstubAllGlobals();
    expect(created).toHaveLength(1);
    expect(created[0]?.url.pathname.endsWith('/${id}/worker.ts')).toBe(true);
    expect(created[0]?.options).toEqual({ type: 'module' });
  });
});
`;
  }
  return {
    files,
    messages: [
      [toolTextKey(id, 'name'), name],
      [toolTextKey(id, 'description'), `${name} in your browser.`],
      [toolTextKey(id, 'keywords'), id.split('-').join(' ')],
    ],
  };
}

function renderTest(options: ScaffoldOptions): string {
  const { id, name } = options;
  return `import { describe, expect, it } from 'vitest';
import manifest from '../../src/tools/${id}/manifest.ts';
import { openTool } from '../tool-helpers.ts';

describe(${quote(id)}, () => {
  it('keeps the privacy promise in its manifest', () => {
    expect(manifest.fileContent).toBe('stays-in-browser');
    expect(manifest.runsIn).toBe('client');
  });

  it('opens at /tools/${id} with exactly one heading: its name', async () => {
    const view = await openTool(manifest);
    expect(view.path).toBe('/tools/${id}');
    expect(view.headings).toEqual([${quote(name)}]);
    expect(view.main.textContent).toContain('Your files stay in this browser');
  });

  it('is found by search and listed with its category', async () => {
    const view = await openTool(manifest);
    expect(view.searchHits(${quote(name.toLowerCase())})).toEqual([${quote(id)}]);
  });
});
`;
}

/**
 * The browser spec every tool brings (CLAUDE.md, "Tools"): the page opens with one `h1`, passes
 * the accessibility gate (axe, WCAG 2.2 AA), and every control can be reached with Tab alone.
 * The author adds the states of the tool: `a11y.check(page, '<state>')` after each one, and
 * `net.watch(file)` for each uploaded file so the privacy check can see it.
 */
function renderSpec(options: ScaffoldOptions): string {
  const { id, name } = options;
  return `import { expect, test } from '../support/fixtures.ts';
import { expectKeyboardOnly } from '../support/keyboard.ts';

// ${name} in the built app, in Chromium and Firefox (T-05, #13: the accessibility gate applies to
// every tool). Add a test per state of the tool; call \`a11y.check(page, '<state>')\` after each
// one, and \`net.watch(file)\` for each file the test uploads.
test.describe(${quote(id)}, () => {
  test('opens with one heading and passes the accessibility gate', async ({ page, a11y }) => {
    await page.goto('/tools/${id}');
    await expect(page.getByRole('heading', { level: 1, name: ${quote(name)}, exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await a11y.check(page, ${quote(id)});
  });

  test('can be used with the keyboard alone', async ({ page }) => {
    await page.goto('/tools/${id}');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectKeyboardOnly(page, ${quote(id)});
  });
});
`;
}

export class ScaffoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScaffoldError';
  }
}

async function formatted(path: string, content: string): Promise<string> {
  const config = (await resolveConfig(path)) ?? {};
  return format(content, { ...config, filepath: path });
}

function insertMessages(
  source: string,
  closing: string,
  messages: Rendered['messages'],
  path: string,
): string {
  const at = source.lastIndexOf(closing);
  if (at === -1) {
    throw new ScaffoldError(`${path}: cannot find the end of the catalogue (${closing.trim()})`);
  }
  const lines = messages.map(([key, text]) => `  ${quote(key)}: ${quote(text)},`).join('\n');
  return `${source.slice(0, at)}\n\n${lines}\n${source.slice(at)}`;
}

/**
 * Creates the tool in the app at `root`: manifest, page, test, and the three texts in both
 * catalogues. Refuses to touch anything when the tool or one of its message keys already exists.
 * Returns the paths written, relative to `root`.
 */
export async function scaffoldTool(
  options: ScaffoldOptions,
  root: string = APP_ROOT,
): Promise<readonly string[]> {
  const rendered = renderTool(options);
  const catalogs = ['en', 'de'].map((locale) => `src/i18n/messages/${locale}.ts`);
  const toolDir = join(root, 'src', 'tools', options.id);
  if (existsSync(toolDir)) {
    throw new ScaffoldError(`src/tools/${options.id} already exists`);
  }
  for (const file of Object.keys(rendered.files)) {
    if (existsSync(join(root, file))) {
      throw new ScaffoldError(`${file} already exists`);
    }
  }
  const sources = new Map<string, string>();
  for (const catalog of catalogs) {
    const path = join(root, catalog);
    if (!existsSync(path)) {
      throw new ScaffoldError(`${catalog} does not exist: is ${root} the app directory?`);
    }
    const source = readFileSync(path, 'utf8');
    for (const [key] of rendered.messages) {
      if (source.includes(quote(key))) {
        throw new ScaffoldError(`${catalog} already has the message ${key}`);
      }
    }
    sources.set(catalog, source);
  }

  // Everything is prepared; only now is anything written.
  const written: string[] = [];
  for (const catalog of catalogs) {
    const closing = catalog.endsWith('en.ts') ? '\n} as const satisfies' : '\n};';
    const next = insertMessages(sources.get(catalog) ?? '', closing, rendered.messages, catalog);
    writeFileSync(join(root, catalog), await formatted(join(root, catalog), next));
    written.push(catalog);
  }
  for (const [file, content] of Object.entries(rendered.files)) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, await formatted(path, content));
    written.push(file);
  }
  return written;
}

export interface ScaffoldIo {
  readonly out: (message: string) => void;
  readonly err: (message: string) => void;
}

/** CLI logic of `pnpm new-tool`; returns the exit code (0 created, 1 refused, 2 usage). */
export async function runScaffoldCli(
  args: readonly string[],
  io: ScaffoldIo,
  root: string = APP_ROOT,
): Promise<number> {
  const parsed = parseScaffoldArgs(args);
  if (!parsed.ok) {
    io.err(`${parsed.error}\n${USAGE}`);
    return 2;
  }
  try {
    const written = await scaffoldTool(parsed.options, root);
    io.out(`created ${parsed.options.id}:\n${written.map((file) => `  ${file}`).join('\n')}`);
    io.out(
      [
        'next:',
        `  - choose category and sticker in src/tools/${parsed.options.id}/manifest.ts (now ${parsed.options.category}, ${parsed.options.sticker})`,
        '  - translate the German texts in src/i18n/messages/de.ts',
        `  - extend e2e/specs/${parsed.options.id}.spec.ts: one test per state, a11y.check after each (pnpm e2e)`,
        `  - build the tool in src/tools/${parsed.options.id}/Tool.svelte, inside <ToolFrame>`,
        '  - pnpm lint && pnpm typecheck && pnpm test',
      ].join('\n'),
    );
    return 0;
  } catch (error: unknown) {
    if (error instanceof ScaffoldError) {
      io.err(error.message);
      return 1;
    }
    throw error;
  }
}
