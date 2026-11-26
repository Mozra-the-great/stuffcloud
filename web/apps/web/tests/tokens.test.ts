import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  generateTokensCss,
  parseRootTokens,
  renderTokensCss,
  runTokensCli,
  SOURCE_PATH,
  type TokenIo,
} from '../scripts/tokens.ts';
import {
  appRoot,
  readAppFile,
  readCustomProperties,
  readRepoFile,
  readRepoFiles,
} from './helpers.ts';

describe('parseRootTokens', () => {
  it('reads the custom properties of the :root rule in order', () => {
    expect(parseRootTokens(':root{--a:#111;--b:#222}')).toEqual([
      { name: '--a', value: '#111' },
      { name: '--b', value: '#222' },
    ]);
  });

  it('ignores comments, other rules and surrounding whitespace', () => {
    const css = `/* :root{--x:1} */ body{margin:0}\n:root {\n  --a : #111 ;\n  /* c */\n  --b:  2px  3px;\n}\n:root{--later:1}`;
    expect(parseRootTokens(css)).toEqual([
      { name: '--a', value: '#111' },
      { name: '--b', value: '2px 3px' },
    ]);
  });

  it('keeps quoted font names and spaces the list items', () => {
    expect(parseRootTokens(":root{--f:'JetBrains Mono',ui-monospace,monospace}")).toEqual([
      { name: '--f', value: "'JetBrains Mono', ui-monospace, monospace" },
    ]);
  });

  it('does not split on separators inside quotes or parentheses', () => {
    expect(parseRootTokens(`:root{--q:"a;b,c";--c:rgba(0,0,0,.4)}`)).toEqual([
      { name: '--q', value: '"a;b,c"' },
      { name: '--c', value: 'rgba(0,0,0,.4)' },
    ]);
  });

  it('throws when there is no :root rule', () => {
    expect(() => parseRootTokens('body{margin:0}')).toThrow(
      'no :root rule found in the design stylesheet',
    );
  });

  it('throws on an empty :root rule', () => {
    expect(() => parseRootTokens(':root{}')).toThrow(':root rule has no tokens');
    expect(() => parseRootTokens(':root{ ; ;}')).toThrow(':root rule has no tokens');
  });

  it('throws on a declaration that is not a custom property', () => {
    expect(() => parseRootTokens(':root{color:red}')).toThrow(
      ':root declaration is not a custom property: color:red',
    );
    expect(() => parseRootTokens(':root{--Bad:1}')).toThrow('not a custom property');
    expect(() => parseRootTokens(':root{--novalue}')).toThrow('not a custom property');
  });

  it('throws on an empty value', () => {
    expect(() => parseRootTokens(':root{--a: }')).toThrow('token --a has an empty value');
  });

  it('throws on a duplicate name', () => {
    expect(() => parseRootTokens(':root{--a:1;--a:2}')).toThrow('token --a is defined twice');
  });
});

describe('renderTokensCss', () => {
  it('writes a banner, one declaration per token and a final newline', () => {
    const css = renderTokensCss([{ name: '--a', value: '#111' }]);
    expect(css).toContain(`GENERATED from the :root rule of ${SOURCE_PATH}`);
    expect(css).toContain('Do not edit');
    expect(css.endsWith(':root {\n  --a: #111;\n}\n')).toBe(true);
  });

  it('is deterministic', () => {
    const tokens = parseRootTokens(readRepoFile(SOURCE_PATH));
    expect(renderTokensCss(tokens)).toBe(renderTokensCss(tokens));
  });
});

describe('runTokensCli', () => {
  interface Spy {
    readonly io: TokenIo;
    readonly out: string[];
    readonly err: string[];
    written: string | undefined;
  }

  function spy(options: { source: () => string; generated: string | undefined }): Spy {
    const result: Spy = {
      out: [],
      err: [],
      written: undefined,
      io: {
        readSource: options.source,
        readGenerated: () => options.generated,
        writeGenerated: (content) => {
          result.written = content;
        },
        out: (message) => result.out.push(message),
        err: (message) => result.err.push(message),
      },
    };
    return result;
  }

  const source = ':root{--a:#111}';
  const expected = generateTokensCss(source);

  it('--write writes the generated stylesheet', () => {
    const run = spy({ source: () => source, generated: undefined });
    expect(runTokensCli(['--write'], run.io)).toBe(0);
    expect(run.written).toBe(expected);
    expect(run.out).toEqual(['tokens.css written']);
  });

  it('--check passes when the file is current (and is the default)', () => {
    for (const args of [['--check'], []]) {
      const run = spy({ source: () => source, generated: expected });
      expect(runTokensCli(args, run.io)).toBe(0);
      expect(run.out).toEqual(['tokens.css is current']);
      expect(run.written).toBeUndefined();
    }
  });

  it('--check fails when the file is stale or missing', () => {
    for (const generated of ['stale', undefined]) {
      const run = spy({ source: () => source, generated });
      expect(runTokensCli(['--check'], run.io)).toBe(1);
      expect(run.err).toEqual([
        'tokens.css is stale: run `pnpm tokens` in web/ and commit the result',
      ]);
    }
  });

  it('rejects an unknown argument with exit code 2', () => {
    const run = spy({ source: () => source, generated: expected });
    expect(runTokensCli(['--nope'], run.io)).toBe(2);
    expect(run.err).toEqual(['unknown argument --nope; use --write or --check']);
  });

  it('reports a broken design stylesheet', () => {
    const run = spy({ source: () => 'body{}', generated: expected });
    expect(runTokensCli(['--check'], run.io)).toBe(1);
    expect(run.err).toEqual(['no :root rule found in the design stylesheet']);
  });

  it('reports a thrown non-error value', () => {
    const run = spy({
      source: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- covers the non-Error branch
        throw 'boom';
      },
      generated: expected,
    });
    expect(runTokensCli(['--check'], run.io)).toBe(1);
    expect(run.err).toEqual(['boom']);
  });
});

describe('generated tokens.css', () => {
  it('is current: it matches what the design stylesheet generates', () => {
    expect(
      readAppFile('src/styles/tokens.css'),
      'tokens.css is stale: run `pnpm tokens` in web/ and commit the result',
    ).toBe(generateTokensCss(readRepoFile(SOURCE_PATH)));
  });

  it('is checked by the CLI the same way (exit code 0, and 1 for a stale copy)', () => {
    const script = resolve(appRoot, 'scripts/gen-tokens.ts');
    const output = execFileSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
    expect(output.trim()).toBe('tokens.css is current');
    expect(() => execFileSync(process.execPath, [script, '--bogus'], { stdio: 'pipe' })).toThrow();
  });

  it('carries every token of the design stylesheet, none of its own', () => {
    const design = parseRootTokens(readRepoFile(SOURCE_PATH));
    const generated = readCustomProperties('src/styles/tokens.css');
    expect([...generated.keys()]).toEqual(design.map((token) => token.name));
    for (const token of design) {
      expect(generated.get(token.name)).toBe(token.value);
    }
  });

  it('agrees with the token table in docs/design/README.md', () => {
    const readme = readRepoFile('docs/design/README.md');
    const table = readme.slice(
      readme.indexOf('### Tokens'),
      readme.indexOf('### Specific decisions'),
    );
    const documented = new Set(
      [...table.matchAll(/`(#[0-9a-f]{6})`/gi)].map((m) => m[1]?.toLowerCase()),
    );
    const colours = new Set(
      [...readCustomProperties('src/styles/tokens.css').values()]
        .filter((value) => /^#[0-9a-f]{6}$/i.test(value))
        .map((value) => value.toLowerCase()),
    );
    expect(documented.size).toBeGreaterThan(0);
    expect(documented).toEqual(colours);
  });
});

describe('theme.css', () => {
  const design = [readRepoFile(SOURCE_PATH), ...readRepoFiles('docs/design/prototypes', '.html')]
    .join('\n')
    .toLowerCase();

  it('invents no colour: every literal appears in the design sources', () => {
    const theme = readAppFile('src/styles/theme.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const literals = [...theme.matchAll(/#[0-9a-f]{6}\b/gi)].map((m) => m[0].toLowerCase());
    expect(literals.length).toBeGreaterThan(5);
    for (const literal of literals) {
      expect(design, `${literal} is not in docs/design`).toContain(literal);
    }
  });

  it('does not redefine a generated token', () => {
    const generated = readCustomProperties('src/styles/tokens.css');
    const theme = readCustomProperties('src/styles/theme.css');
    for (const name of theme.keys()) {
      expect(generated.has(name), `${name} is defined in tokens.css and theme.css`).toBe(false);
    }
  });

  it('matches the touch target sizes of the design (44 px, 48 px for icons)', () => {
    const theme = readCustomProperties('src/styles/theme.css');
    expect(theme.get('--target-min')).toBe('44px');
    expect(theme.get('--target-icon')).toBe('48px');
    expect(theme.get('--control-h')).toBe('52px');
  });
});

describe('no magic values in components', () => {
  const files = [
    'src/ui/field.css',
    'src/ui/Checkbox.svelte',
    'src/gallery/Gallery.svelte',
    'src/App.svelte',
  ];

  it.each(files)('%s has no hex or rgb colour literal', (file) => {
    const source = readAppFile(file).replace(/\/\*[\s\S]*?\*\//g, '');
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/\brgba?\(/);
    expect(source).not.toMatch(/\bhsla?\(/);
  });
});
