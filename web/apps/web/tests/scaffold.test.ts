import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type * as Prettier from 'prettier';
import { afterEach, describe, expect, it } from 'vitest';
import { checkTools } from '../scripts/tool-check.ts';
import {
  defaultName,
  parseScaffoldArgs,
  quote,
  renderTool,
  runScaffoldCli,
  scaffoldTool,
  ScaffoldError,
  USAGE,
  type ScaffoldOptions,
} from '../scripts/scaffold.ts';
import { openTool } from './tool-helpers.ts';
import { createTempRoot, type TempRoot } from './tmp-root.ts';

// Node's own resolution, as in scripts/scaffold.ts (the `browser` condition has no resolveConfig).
const { format, resolveConfig } = createRequire(import.meta.url)('prettier') as typeof Prettier;

const trees: TempRoot[] = [];

function tree(): TempRoot {
  const created = createTempRoot();
  trees.push(created);
  return created;
}

afterEach(() => {
  for (const created of trees.splice(0)) {
    created.remove();
  }
});

const BASE: ScaffoldOptions = {
  id: 'merge-pdf',
  category: 'pdf',
  sticker: 'pdf-merge',
  name: 'Merge PDFs',
  worker: false,
};

function read(root: string, path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

describe('parseScaffoldArgs', () => {
  it('takes just an id and fills in the rest', () => {
    expect(parseScaffoldArgs(['merge-pdf'])).toEqual({
      ok: true,
      options: {
        id: 'merge-pdf',
        category: 'extra',
        sticker: 'shield',
        name: 'Merge pdf',
        worker: false,
      },
    });
  });

  it('takes every option, in any order', () => {
    expect(
      parseScaffoldArgs([
        '--worker',
        '--name',
        'Merge PDFs',
        'merge-pdf',
        '--sticker',
        'pdf-merge',
        '--category',
        'pdf',
      ]),
    ).toEqual({ ok: true, options: { ...BASE, worker: true } });
  });

  it.each([
    [[], 'the tool id is missing'],
    [['a', 'b'], 'unexpected argument "b"'],
    [['a', '--nope'], 'unknown option --nope'],
    [['a', '--category'], '--category needs a value'],
    [['a', '--category', '--worker'], '--category needs a value'],
    [['a', '--sticker'], '--sticker needs a value'],
    [['a', '--name'], '--name needs a value'],
    [['Merge'], '"Merge" is not a valid tool id (invalid-characters)'],
    [[''], '"" is not a valid tool id (empty)'],
    [['a'.repeat(49)], 'too-long'],
    [['a', '--category', 'office'], '"office" is not a category (pdf, image,'],
    [['a', '--sticker', 'unicorn'], '"unicorn" is not a sticker (base64,'],
    [['a', '--name', '  '], 'the name must be 1 to 40 characters'],
    [['a', '--name', 'x'.repeat(41)], 'the name must be 1 to 40 characters'],
    [['a', '--name', 'Merge {x}'], 'without braces or control characters'],
    [['a', '--name', 'two\nlines'], 'without braces or control characters'],
  ])('refuses %j', (args, message) => {
    const result = parseScaffoldArgs(args);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(message);
  });

  it('accepts a name of exactly 40 characters and trims it', () => {
    const name = 'x'.repeat(40);
    const result = parseScaffoldArgs(['a', '--name', `  ${name} `]);
    expect(result.ok && result.options.name).toBe(name);
  });
});

describe('small helpers', () => {
  it('defaultName makes words out of an id', () => {
    expect(defaultName('merge-pdf')).toBe('Merge pdf');
    expect(defaultName('qr')).toBe('Qr');
    expect(defaultName('a-b-c')).toBe('A b c');
  });

  it('quote escapes what would end or break a string literal', () => {
    expect(quote('plain')).toBe("'plain'");
    expect(quote("it's")).toBe("'it\\'s'");
    expect(quote('back\\slash')).toBe("'back\\\\slash'");
  });
});

describe('renderTool', () => {
  it('describes a client tool: manifest, page, test, three texts', () => {
    const { files, messages } = renderTool(BASE);
    expect(Object.keys(files).toSorted()).toEqual([
      'e2e/specs/merge-pdf.spec.ts',
      'src/tools/merge-pdf/Tool.svelte',
      'src/tools/merge-pdf/manifest.ts',
      'tests/tools/merge-pdf.test.ts',
    ]);
    expect(messages).toEqual([
      ['tool.merge-pdf.name', 'Merge PDFs'],
      ['tool.merge-pdf.description', 'Merge PDFs in your browser.'],
      ['tool.merge-pdf.keywords', 'merge pdf'],
    ]);
  });

  it('puts the privacy promise and the keys into the manifest', () => {
    const manifest = renderTool(BASE).files['src/tools/merge-pdf/manifest.ts'] ?? '';
    expect(manifest).toContain("fileContent: 'stays-in-browser'");
    expect(manifest).toContain("runsIn: 'client'");
    expect(manifest).toContain("nameKey: 'tool.merge-pdf.name'");
    expect(manifest).toContain("descriptionKey: 'tool.merge-pdf.description'");
    expect(manifest).toContain("keywordsKey: 'tool.merge-pdf.keywords'");
    expect(manifest).toContain("category: 'pdf'");
    expect(manifest).toContain("sticker: 'pdf-merge'");
    expect(manifest).toContain('requires: []');
    expect(manifest).toContain("load: () => import('./Tool.svelte')");
  });

  it('wraps the page in the frame, which owns the one h1', () => {
    const page = renderTool(BASE).files['src/tools/merge-pdf/Tool.svelte'] ?? '';
    expect(page).toContain('ToolFrame');
    expect(page).not.toContain('<h1');
  });

  it('brings a browser spec: one h1, the axe gate, and a keyboard-only walk', () => {
    const spec = renderTool(BASE).files['e2e/specs/merge-pdf.spec.ts'] ?? '';
    expect(spec).toContain("import { expect, test } from '../support/fixtures.ts';");
    expect(spec).toContain("import { expectKeyboardOnly } from '../support/keyboard.ts';");
    expect(spec).toContain("page.goto('/tools/merge-pdf')");
    expect(spec).toContain("name: 'Merge PDFs', exact: true");
    expect(spec).toContain("a11y.check(page, 'merge-pdf')");
    expect(spec).toContain("expectKeyboardOnly(page, 'merge-pdf')");
    expect(spec).toContain('net.watch(file)');
  });

  it('quotes the name in the browser spec', () => {
    const spec = renderTool({ ...BASE, name: "Don't merge" }).files['e2e/specs/merge-pdf.spec.ts'];
    expect(spec).toContain("name: 'Don\\'t merge', exact: true");
  });

  it('adds task, worker, pool and their test for a worker tool and requires the capability', () => {
    const { files } = renderTool({ ...BASE, worker: true });
    expect(Object.keys(files).toSorted()).toEqual([
      'e2e/specs/merge-pdf.spec.ts',
      'src/tools/merge-pdf/Tool.svelte',
      'src/tools/merge-pdf/manifest.ts',
      'src/tools/merge-pdf/pool.ts',
      'src/tools/merge-pdf/task.ts',
      'src/tools/merge-pdf/worker.ts',
      'tests/tools/merge-pdf.test.ts',
      'tests/tools/merge-pdf.worker.test.ts',
    ]);
    expect(files['src/tools/merge-pdf/manifest.ts']).toContain("requires: ['worker']");
    expect(files['src/tools/merge-pdf/worker.ts']).toContain('serveWorker(runTask)');
    expect(files['src/tools/merge-pdf/pool.ts']).toContain(
      "new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })",
    );
  });

  it('escapes quotes in the name and the id in the test', () => {
    const { files, messages } = renderTool({ ...BASE, name: "Don't merge" });
    expect(messages[0]).toEqual(['tool.merge-pdf.name', "Don't merge"]);
    expect(files['tests/tools/merge-pdf.test.ts']).toContain("'Don\\'t merge'");
  });

  it('writes a test that uses the helper this repo has', () => {
    expect(typeof openTool).toBe('function');
    expect(renderTool(BASE).files['tests/tools/merge-pdf.test.ts']).toContain('openTool(manifest)');
  });
});

describe('scaffoldTool', () => {
  it('writes the files and both catalogues, and the result passes the build check', async () => {
    const target = tree();
    const written = await scaffoldTool(BASE, target.root);
    expect(written).toEqual([
      'src/i18n/messages/en.ts',
      'src/i18n/messages/de.ts',
      'src/tools/merge-pdf/manifest.ts',
      'src/tools/merge-pdf/Tool.svelte',
      'tests/tools/merge-pdf.test.ts',
      'e2e/specs/merge-pdf.spec.ts',
    ]);
    for (const file of written) {
      expect(existsSync(join(target.root, file))).toBe(true);
    }
    expect(await checkTools(target.root)).toEqual([]);
  });

  it('puts the three texts in both catalogues, after a blank line, and keeps the rest', async () => {
    const target = tree();
    const beforeEn = read(target.root, 'src/i18n/messages/en.ts');
    await scaffoldTool(BASE, target.root);
    const en = read(target.root, 'src/i18n/messages/en.ts');
    const de = read(target.root, 'src/i18n/messages/de.ts');
    for (const source of [en, de]) {
      expect(source).toContain("  'tool.merge-pdf.name': 'Merge PDFs',");
      expect(source).toContain("  'tool.merge-pdf.description': 'Merge PDFs in your browser.',");
      expect(source).toContain("  'tool.merge-pdf.keywords': 'merge pdf',");
    }
    // The new texts follow the last entry of the catalogue after a blank line, whatever that is.
    expect(en).toMatch(/,\n\n {2}'tool\.merge-pdf\.name'/);
    expect(en.startsWith(beforeEn.slice(0, 200))).toBe(true);
    expect(en.endsWith('export type MessageKey = keyof typeof en;\n')).toBe(true);
    expect(de.trimEnd().endsWith('};')).toBe(true);
  });

  it('leaves every file formatted exactly as Prettier would', async () => {
    const target = tree();
    const written = await scaffoldTool(
      { ...BASE, worker: true, name: 'Merge PDFs, quickly' },
      target.root,
    );
    for (const file of written) {
      const path = join(target.root, file);
      const source = read(target.root, file);
      const config = (await resolveConfig(path)) ?? {};
      expect(await format(source, { ...config, filepath: path }), file).toBe(source);
    }
  });

  it('handles a second tool: the catalogues keep growing, the check stays green', async () => {
    const target = tree();
    await scaffoldTool(BASE, target.root);
    await scaffoldTool(
      { ...BASE, id: 'split-pdf', name: 'Split PDF', sticker: 'pdf-split' },
      target.root,
    );
    expect(await checkTools(target.root)).toEqual([]);
    expect(read(target.root, 'src/i18n/messages/en.ts')).toContain('tool.split-pdf.name');
  });

  it('creates a worker tool that passes the build check and requires the worker capability', async () => {
    const target = tree();
    await scaffoldTool({ ...BASE, worker: true }, target.root);
    expect(await checkTools(target.root)).toEqual([]);
    expect(read(target.root, 'src/tools/merge-pdf/manifest.ts')).toContain("requires: ['worker']");
  });

  it('refuses an existing tool and changes nothing', async () => {
    const target = tree();
    mkdirSync(join(target.root, 'src/tools/merge-pdf'), { recursive: true });
    const before = read(target.root, 'src/i18n/messages/en.ts');
    await expect(scaffoldTool(BASE, target.root)).rejects.toThrow(
      new ScaffoldError('src/tools/merge-pdf already exists'),
    );
    expect(read(target.root, 'src/i18n/messages/en.ts')).toBe(before);
    expect(existsSync(join(target.root, 'tests/tools'))).toBe(false);
  });

  it('refuses when its test file already exists', async () => {
    const target = tree();
    target.write('tests/tools/merge-pdf.test.ts', '// mine');
    const before = read(target.root, 'src/i18n/messages/de.ts');
    await expect(scaffoldTool(BASE, target.root)).rejects.toThrow(
      'tests/tools/merge-pdf.test.ts already exists',
    );
    expect(read(target.root, 'src/i18n/messages/de.ts')).toBe(before);
    expect(existsSync(join(target.root, 'src/tools/merge-pdf'))).toBe(false);
  });

  it.each(['en', 'de'])(
    'refuses when the %s catalogue already has a key, writing nothing',
    async (locale) => {
      const target = tree();
      const path = `src/i18n/messages/${locale}.ts`;
      const source = read(target.root, path);
      const at = source.lastIndexOf(locale === 'en' ? '\n} as const satisfies' : '\n};');
      target.write(
        path,
        `${source.slice(0, at)}\n  'tool.merge-pdf.keywords': 'x',${source.slice(at)}`,
      );
      await expect(scaffoldTool(BASE, target.root)).rejects.toThrow(
        `${path} already has the message tool.merge-pdf.keywords`,
      );
      expect(existsSync(join(target.root, 'src/tools/merge-pdf'))).toBe(false);
    },
  );

  it('refuses a directory that is not the app', async () => {
    const target = tree();
    rmSync(join(target.root, 'src/i18n/messages/de.ts'));
    await expect(scaffoldTool(BASE, target.root)).rejects.toThrow(
      /src\/i18n\/messages\/de\.ts does not exist: is .* the app directory\?/,
    );
  });

  it('refuses a catalogue whose end it cannot find', async () => {
    const target = tree();
    target.write('src/i18n/messages/en.ts', 'export const en = {};\n');
    await expect(scaffoldTool(BASE, target.root)).rejects.toThrow(
      'src/i18n/messages/en.ts: cannot find the end of the catalogue',
    );
    expect(existsSync(join(target.root, 'src/tools/merge-pdf'))).toBe(false);
  });
});

describe('pnpm new-tool (runScaffoldCli)', () => {
  function run(
    args: string[],
    root: string,
  ): Promise<{ code: number; out: string[]; err: string[] }> {
    const out: string[] = [];
    const err: string[] = [];
    return runScaffoldCli(args, { out: (m) => out.push(m), err: (m) => err.push(m) }, root).then(
      (code) => ({ code, out, err }),
    );
  }

  it('creates the tool, lists what it wrote and what to do next (exit 0)', async () => {
    const target = tree();
    const result = await run(
      ['merge-pdf', '--category', 'pdf', '--sticker', 'pdf-merge'],
      target.root,
    );
    expect(result.code).toBe(0);
    expect(result.out[0]).toContain('created merge-pdf:');
    expect(result.out[0]).toContain('  src/tools/merge-pdf/manifest.ts');
    expect(result.out[1]).toContain('choose category and sticker');
    expect(result.out[1]).toContain('(now pdf, pdf-merge)');
    expect(result.out[1]).toContain('translate the German texts');
    expect(result.err).toEqual([]);
    expect(await checkTools(target.root)).toEqual([]);
  });

  it('prints the usage for bad arguments (exit 2) and writes nothing', async () => {
    const target = tree();
    const result = await run(['Bad Id'], target.root);
    expect(result.code).toBe(2);
    expect(result.err[0]).toContain('is not a valid tool id');
    expect(result.err[0]).toContain(USAGE);
    expect(existsSync(join(target.root, 'src/tools/Bad Id'))).toBe(false);
  });

  it('says what is in the way (exit 1)', async () => {
    const target = tree();
    await run(['merge-pdf'], target.root);
    const again = await run(['merge-pdf'], target.root);
    expect(again.code).toBe(1);
    expect(again.err).toEqual(['src/tools/merge-pdf already exists']);
  });

  it('does not hide an unexpected failure', async () => {
    const target = tree();
    rmSync(join(target.root, 'src/tools'), { recursive: true });
    writeFileSync(join(target.root, 'src/tools'), 'a file where the directory should be');
    await expect(run(['merge-pdf'], target.root)).rejects.toThrow();
  });
});
