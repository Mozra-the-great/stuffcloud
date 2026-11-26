import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appRoot, readAppFile, readCustomProperties, readKernCodeTokens } from './helpers.ts';

/** Every `.svelte`, `.ts` and `.css` file under the given directories of the app. */
function sourceFiles(...dirs: readonly string[]): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (/\.(svelte|ts|css)$/.test(entry.name)) {
        files.push(path);
      }
    }
  };
  for (const dir of dirs) {
    walk(resolve(appRoot, dir));
  }
  return files;
}

describe('kern is the token source (ADR 0016)', () => {
  const kern = readKernCodeTokens();
  const local = readCustomProperties('src/styles/theme.css');

  it('reads kern tokens from the installed Code theme', () => {
    expect(kern.get('--k-bg')).toBe('#101012');
    expect(kern.get('--k-accent')).toBe('#ff79b0');
    expect(kern.size).toBeGreaterThan(100);
  });

  it('keeps the app-local tokens to a minimum: only --sc-*, each waiting for a kern issue', () => {
    const css = readAppFile('src/styles/theme.css');
    expect([...local.keys()]).toEqual(['--sc-stage']);
    for (const name of local.keys()) {
      expect(name.startsWith('--sc-')).toBe(true);
      expect(kern.has(name)).toBe(false);
    }
    expect(css).toMatch(/waiting for kern#\d+/);
  });

  it('ships no generated token file and no token script', () => {
    const files = sourceFiles('src/styles', 'scripts').map((path) => path.split(sep).join('/'));
    expect(files.some((path) => path.endsWith('/tokens.css'))).toBe(false);
    expect(files.some((path) => /\/(gen-)?tokens\.ts$/.test(path))).toBe(false);
    expect(readAppFile('package.json')).not.toMatch(/"tokens(:check)?"/);
  });

  it('resolves every var(--name) of the sources to a kern token or an app-local token', () => {
    const used = new Map<string, string>();
    for (const file of sourceFiles('src', 'e2e/app')) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/var\((--[a-z0-9-]+)/g)) {
        used.set(match[1] ?? '', file);
      }
    }
    expect(used.size).toBeGreaterThan(20);
    for (const [name, file] of used) {
      expect(kern.has(name) || local.has(name), `${name} (${file}) is not a token`).toBe(true);
    }
  });

  it('gives the touch targets the design needs (44 px, 48 px for icons, 52 px controls)', () => {
    expect(kern.get('--k-tap-min')).toBe('44px');
    expect(kern.get('--k-tap-icon')).toBe('48px');
    expect(kern.get('--k-control-h')).toBe('52px');
  });
});

describe('no magic values in components', () => {
  const files = ['src/gallery/Gallery.svelte', 'src/App.svelte'];

  it.each(files)('%s has no hex or rgb colour literal', (file) => {
    const source = readAppFile(file).replace(/\/\*[\s\S]*?\*\//g, '');
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/\brgba?\(/);
    expect(source).not.toMatch(/\bhsla?\(/);
  });
});
