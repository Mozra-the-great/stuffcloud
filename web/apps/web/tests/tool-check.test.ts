import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  APP_ROOT,
  checkTools,
  formatProblems,
  runCheckCli,
  toolManifestCheck,
} from '../scripts/tool-check.ts';
import { appRoot } from './helpers.ts';
import { addTexts, createTempRoot, manifestSource, type TempRoot } from './tmp-root.ts';

const trees: TempRoot[] = [];

function tree(): TempRoot {
  const created = createTempRoot();
  trees.push(created);
  return created;
}

/** A tree with one valid tool `id`. */
function withTool(id = 'alpha'): TempRoot {
  const created = tree();
  created.write(`src/tools/${id}/manifest.ts`, manifestSource(id));
  addTexts(created, id);
  return created;
}

afterEach(() => {
  for (const created of trees.splice(0)) {
    created.remove();
  }
});

describe('checkTools', () => {
  it('finds nothing wrong in the real app', async () => {
    expect(APP_ROOT).toBe(appRoot);
    expect(await checkTools()).toEqual([]);
  });

  it('accepts a tree without tools', async () => {
    expect(await checkTools(tree().root)).toEqual([]);
  });

  it('accepts a valid tool, and ignores files next to the tool directories', async () => {
    const valid = withTool();
    valid.write('src/tools/README.md', 'not a tool');
    expect(await checkTools(valid.root)).toEqual([]);
  });

  it('reports a manifest that breaks the schema, with the rule and the tool', async () => {
    const broken = tree();
    broken.write('src/tools/alpha/manifest.ts', manifestSource('alpha', { category: "'office'" }));
    addTexts(broken, 'alpha');
    const problems = await checkTools(broken.root);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('src/tools/alpha/manifest.ts');
    expect(problems[0]).toContain('tool manifest "alpha" is invalid');
    expect(problems[0]).toContain('category: "office" is not a category');
  });

  it('reports a tool that promises something other than keeping files in the browser', async () => {
    const broken = tree();
    broken.write(
      'src/tools/alpha/manifest.ts',
      manifestSource('alpha', { fileContent: "'sent-to-server'" }),
    );
    addTexts(broken, 'alpha');
    const [problem] = await checkTools(broken.root);
    expect(problem).toContain('fileContent: must be "stays-in-browser"');
  });

  it('reports a manifest that cannot even be loaded', async () => {
    const broken = tree();
    broken.write('src/tools/alpha/manifest.ts', 'export default (;\n');
    const problems = await checkTools(broken.root);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('src/tools/alpha/manifest.ts:');
  });

  it('reports a tool directory without manifest.ts', async () => {
    const broken = tree();
    mkdirSync(join(broken.root, 'src/tools/empty'), { recursive: true });
    expect(await checkTools(broken.root)).toEqual(['src/tools/empty: manifest.ts is missing']);
  });

  it('reports an id that differs from its directory', async () => {
    const broken = tree();
    broken.write('src/tools/folder/manifest.ts', manifestSource('alpha'));
    addTexts(broken, 'alpha');
    const [problem] = await checkTools(broken.root);
    expect(problem).toContain('the id "alpha" must equal the directory name "folder"');
  });

  it('reports a missing text in a catalogue, naming key and language', async () => {
    const broken = tree();
    broken.write('src/tools/alpha/manifest.ts', manifestSource('alpha'));
    addTexts(broken, 'alpha', ['de:tool.alpha.description']);
    const [problem] = await checkTools(broken.root);
    expect(problem).toContain('alpha.descriptionKey');
    expect(problem).toContain('"tool.alpha.description" has no plain text in the de catalogue');
  });

  it('reports a configuration that disables a tool that does not exist', async () => {
    const valid = withTool();
    valid.write('tools.config.json', '{ "disabled": ["ghost"] }');
    const [problem] = await checkTools(valid.root);
    expect(problem).toContain('tools.config.json is invalid');
    expect(problem).toContain('there is no tool "ghost"');
  });

  it('reports a configuration that is not JSON, and a missing one', async () => {
    const valid = withTool();
    valid.write('tools.config.json', '{ nope');
    expect((await checkTools(valid.root))[0]).toContain('tools.config.json:');
    const missing = tree();
    missing.write('tools.config.json', '{ "disabled": [] }');
    rmSync(join(missing.root, 'tools.config.json'));
    expect((await checkTools(missing.root))[0]).toContain('tools.config.json:');
  });

  it('reports a missing tools directory and missing catalogues', async () => {
    const empty = tree();
    rmSync(join(empty.root, 'src/tools'), { recursive: true });
    expect(await checkTools(empty.root)).toEqual([
      `${join(empty.root, 'src', 'tools')}: the tools directory does not exist`,
    ]);
    const noCatalogs = tree();
    rmSync(join(noCatalogs.root, 'src/i18n'), { recursive: true });
    expect((await checkTools(noCatalogs.root))[0]).toContain('src/i18n/messages:');
  });

  it('lists the problems of several tools together', async () => {
    const broken = tree();
    broken.write('src/tools/alpha/manifest.ts', manifestSource('alpha', { sticker: "'unicorn'" }));
    broken.write('src/tools/beta/manifest.ts', manifestSource('beta', { runsIn: "'server'" }));
    const problems = await checkTools(broken.root);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('sticker');
    expect(problems[1]).toContain('server tools are not allowed in v1');
  });
});

describe('formatProblems', () => {
  it('prints one bullet per problem under a headline', () => {
    expect(formatProblems(['a', 'b'])).toBe('The tool registry is broken:\n- a\n- b');
  });
});

describe('the Vite plugin: a broken manifest fails the build', () => {
  it('lets a valid tree through', async () => {
    const plugin = toolManifestCheck(withTool().root);
    expect(plugin.name).toBe('stuffcloud-tool-manifests');
    await expect((plugin.buildStart as () => Promise<void>)()).resolves.toBeUndefined();
  });

  it('rejects at build start with the problem in the message', async () => {
    const broken = tree();
    broken.write('src/tools/alpha/manifest.ts', manifestSource('alpha', { budget: '{}' }));
    addTexts(broken, 'alpha');
    const plugin = toolManifestCheck(broken.root);
    await expect((plugin.buildStart as () => Promise<void>)()).rejects.toThrow(
      /The tool registry is broken:[\s\S]*budget/,
    );
  });

  async function runBuild(root: string): Promise<void> {
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>t</title>');
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [toolManifestCheck(root)],
      build: { outDir: join(root, 'dist'), emptyOutDir: true },
    });
  }

  it('runs inside a real `vite build`: a valid tree builds', async () => {
    await expect(runBuild(withTool().root)).resolves.toBeUndefined();
  }, 60_000);

  it('runs inside a real `vite build`: a schema violation stops it', async () => {
    const broken = tree();
    broken.write('src/tools/alpha/manifest.ts', manifestSource('alpha', { id: "'Alpha'" }));
    await expect(runBuild(broken.root)).rejects.toThrow(/The tool registry is broken:/);
  }, 60_000);

  it('is part of the real app config, so `pnpm build` is covered', async () => {
    const { default: config } = (await import('../vite.config.ts')) as {
      default: { plugins: { name?: string }[] };
    };
    expect(config.plugins.map((plugin) => plugin.name)).toContain('stuffcloud-tool-manifests');
  });
});

describe('check-tools CLI', () => {
  const io = (): { out: string[]; err: string[]; io: Parameters<typeof runCheckCli>[1] } => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      io: {
        out: (message) => out.push(message),
        err: (message) => err.push(message),
      },
    };
  };

  it('exits 0 for the real app', async () => {
    const run = io();
    expect(await runCheckCli([], run.io)).toBe(0);
    expect(run.out).toEqual(['tool manifests are valid']);
  });

  it('exits 1 and prints the problems for a broken tree', async () => {
    const broken = tree();
    broken.write('src/tools/alpha/manifest.ts', manifestSource('alpha', { requires: "['gpu']" }));
    addTexts(broken, 'alpha');
    const run = io();
    expect(await runCheckCli(['--root', broken.root], run.io)).toBe(1);
    expect(run.err.join('\n')).toContain('The tool registry is broken:');
    expect(run.err.join('\n')).toContain('"gpu" is not a capability');
  });

  it.each([['--bogus'], ['--root'], ['--root', ''], ['--root', 'a', 'b'], ['x']])(
    'exits 2 for the arguments %j',
    async (...args) => {
      const run = io();
      expect(await runCheckCli(args, run.io)).toBe(2);
      expect(run.err).toEqual(['usage: check-tools [--root <app directory>]']);
    },
  );

  it('works as a plain Node script (type stripping, no bundler): 0 for good, 1 for broken', () => {
    const script = resolve(appRoot, 'scripts/check-tools.ts');
    const good = withTool();
    expect(
      execFileSync(process.execPath, [script, '--root', good.root], { encoding: 'utf8' }).trim(),
    ).toBe('tool manifests are valid');

    const broken = tree();
    broken.write('src/tools/alpha/manifest.ts', manifestSource('alpha', { category: "'nope'" }));
    addTexts(broken, 'alpha');
    const result = spawnSync(process.execPath, [script, '--root', broken.root], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('The tool registry is broken:');
    expect(result.stderr).toContain('category: "nope" is not a category');
  }, 60_000);
});
