import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appRoot, readAppFile, readRepoFile } from './helpers.ts';

const fontDir = resolve(appRoot, 'src/assets/fonts');
const fontFiles = readdirSync(fontDir).filter((name) => name.endsWith('.woff2'));
const register = readRepoFile('docs/THIRD-PARTY-ASSETS.md');
const fontsCss = readAppFile('src/styles/fonts.css').replace(/\/\*[\s\S]*?\*\//g, '');

function sha256(file: string): string {
  return createHash('sha256')
    .update(readFileSync(resolve(fontDir, file)))
    .digest('hex');
}

describe('self-hosted fonts', () => {
  it('ship the three families of the design in six files', () => {
    expect(fontFiles.sort()).toEqual([
      'inter-latin-ext-wght-normal.woff2',
      'inter-latin-wght-normal.woff2',
      'jetbrains-mono-latin-ext-wght-normal.woff2',
      'jetbrains-mono-latin-wght-normal.woff2',
      'silkscreen-latin-400-normal.woff2',
      'silkscreen-latin-700-normal.woff2',
    ]);
  });

  it.each(fontFiles)(
    '%s is a woff2 file recorded with its SHA-256 in THIRD-PARTY-ASSETS.md',
    (file) => {
      expect(readFileSync(resolve(fontDir, file)).subarray(0, 4).toString('latin1')).toBe('wOF2');
      const row = register.split('\n').find((line) => line.includes(`\`${file}\``));
      expect(row, `${file} has no row in docs/THIRD-PARTY-ASSETS.md`).toBeDefined();
      expect(row).toContain(sha256(file));
      expect(row).toContain('OFL-1.1');
    },
  );

  it.each(['silkscreen', 'inter', 'jetbrains-mono'])(
    'keeps the OFL text of %s next to the files',
    (family) => {
      const text = readFileSync(resolve(fontDir, `OFL-${family}.txt`), 'utf8');
      expect(text).toContain('SIL OPEN FONT LICENSE Version 1.1');
      expect(text).toContain('Copyright');
    },
  );

  it('is referenced by fonts.css, and every reference exists', () => {
    const urls = [...fontsCss.matchAll(/url\('([^']+)'\)/g)].map((m) => m[1] ?? '');
    expect(urls.length).toBe(fontFiles.length);
    for (const url of urls) {
      expect(url.startsWith('../assets/fonts/')).toBe(true);
      expect(existsSync(resolve(appRoot, 'src/styles', url)), url).toBe(true);
    }
    expect(urls.map((url) => url.split('/').pop()).sort()).toEqual([...fontFiles].sort());
  });

  it('declares the family names the font tokens use', () => {
    const tokens = readAppFile('src/styles/tokens.css');
    for (const family of ['Silkscreen', 'Inter', 'JetBrains Mono']) {
      expect(fontsCss).toContain(`font-family: '${family}'`);
      expect(tokens).toContain(`'${family}'`);
    }
  });

  it('loads nothing from another origin (no http(s) or protocol-relative url)', () => {
    expect(fontsCss).not.toMatch(/https?:|url\(\s*['"]?\/\//);
    expect(fontsCss).not.toContain('@import');
    expect(fontsCss).not.toContain('data:');
  });

  it('uses swap so text is never invisible while a font loads', () => {
    const faces = fontsCss.split('@font-face').slice(1);
    expect(faces.length).toBe(fontFiles.length);
    for (const face of faces) {
      expect(face).toContain('font-display: swap');
    }
  });
});
