import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appRoot } from './helpers.ts';

let outDir = '';
const files = new Map<string, string>();

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), 'stuffcloud-web-build-'));
  await build({
    root: appRoot,
    configFile: resolve(appRoot, 'vite.config.ts'),
    logLevel: 'silent',
    build: { outDir, emptyOutDir: true },
  });
  for (const path of walk(outDir)) {
    files.set(relative(outDir, path).replaceAll('\\', '/'), path);
  }
}, 120_000);

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

function text(pattern: RegExp): string[] {
  return [...files.entries()]
    .filter(([name]) => pattern.test(name))
    .map(([, path]) => readFileSync(path, 'utf8'));
}

describe('production build output', () => {
  it('emits the app page and the component gallery', () => {
    expect(files.has('index.html')).toBe(true);
    expect(files.has('gallery.html')).toBe(true);
  });

  it('emits all six font files as separate assets (never inlined)', () => {
    const fonts = [...files.keys()].filter((name) => name.endsWith('.woff2'));
    expect(fonts).toHaveLength(6);
    for (const name of fonts) {
      expect(name.startsWith('assets/')).toBe(true);
    }
  });

  it('references fonts by same-origin path only, and every referenced file exists', () => {
    const css = text(/\.css$/).join('\n');
    const urls = [...css.matchAll(/url\(([^)]+)\)/g)].map((m) => (m[1] ?? '').replace(/['"]/g, ''));
    expect(urls.length).toBeGreaterThanOrEqual(6);
    for (const url of urls) {
      expect(url, 'an asset URL leaves the origin or is inlined').toMatch(/^\/assets\/[\w.-]+$/);
      expect(files.has(url.slice(1)), `${url} is missing from the build`).toBe(true);
    }
  });

  it('emits the nine mascot svgs as files and never inlines them', () => {
    const svgs = [...files.keys()].filter((name) => name.endsWith('.svg'));
    expect(svgs).toHaveLength(9);
    for (const name of svgs) {
      expect(name.startsWith('assets/')).toBe(true);
    }
    const scripts = text(/\.js$/).join('\n');
    expect(scripts).not.toContain('data:image/svg+xml');
    for (const name of svgs) {
      expect(scripts, `${name} is not referenced by the app`).toContain(
        name.slice('assets/'.length),
      );
    }
  });

  it('ships the mascot motion as a transform-only, reduced-motion-aware stylesheet', () => {
    const css = text(/\.css$/).join('\n');
    const has = (pattern: RegExp): boolean => pattern.test(css);
    // The minifier writes `steps(1)` as `step-end` and `100%` as `to`; same meaning.
    expect(has(/animation:1\.2s step-end infinite [\w-]*bob\}/), 'two-step idle animation').toBe(
      true,
    );
    expect(
      has(
        /@keyframes [\w-]*bob\{0%,49%\{transform:translateY\(0\)\}50%,to\{transform:translateY\(-4px\)\}\}/,
      ),
      'transform-only keyframes',
    ).toBe(true);
    expect(
      has(
        /@media \(prefers-reduced-motion:reduce\)\{\[data-motion\][\w.-]* img[^{]*\{animation:none\}\}/,
      ),
      'reduced motion shows the still pose',
    ).toBe(true);
    expect(has(/image-rendering:pixelated/), 'pixelated scaling').toBe(true);
  });

  it('keeps the benchmark out of the build', () => {
    expect([...files.keys()].some((name) => name.includes('bench'))).toBe(false);
  });

  it('has no external or data: reference in css or html', () => {
    for (const content of [...text(/\.css$/), ...text(/\.html$/)]) {
      expect(content).not.toMatch(/(?:src|href)=["']https?:/);
      expect(content).not.toMatch(/url\(\s*["']?(?:https?:)?\/\//);
      expect(content).not.toContain('fonts.googleapis.com');
      expect(content).not.toContain('fonts.gstatic.com');
      expect(content).not.toMatch(/url\(\s*["']?data:/);
      expect(content).not.toContain('@import');
    }
  });

  it('has no font CDN anywhere in the scripts', () => {
    for (const content of text(/\.js$/)) {
      expect(content).not.toContain('fonts.googleapis.com');
      expect(content).not.toContain('fonts.gstatic.com');
    }
  });

  it('keeps the design tokens in the shipped stylesheet', () => {
    const css = text(/\.css$/).join('\n');
    expect(css).toContain('--bg:#101012');
    expect(css).toContain('--pix:"Silkscreen"');
  });
});
