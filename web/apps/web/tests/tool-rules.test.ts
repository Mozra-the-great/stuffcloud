import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderTool } from '../scripts/scaffold.ts';
import { appRoot } from './helpers.ts';

/**
 * Invariants of SPEC 7 and ADR 0004 that hold for every tool, enforced on the sources:
 * a tool never sends file content anywhere, and every tool page is one `ToolFrame`.
 * (The end-to-end test that no tool sends a request with file content comes with Playwright, T-06.)
 */

const NETWORK_APIS: readonly (readonly [name: string, pattern: RegExp])[] = [
  ['fetch()', /(?<![\w$.])fetch\s*\(/],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/],
  ['navigator.sendBeacon', /\bsendBeacon\b/],
  ['WebSocket', /\bWebSocket\b/],
  ['EventSource', /\bEventSource\b/],
  ['WebTransport', /\bWebTransport\b/],
  ['RTCPeerConnection', /\bRTCPeerConnection\b/],
  ['an absolute URL', /\b(?:https?|wss?):\/\//],
];

/** What in `source` could send data off the device. */
function networkUse(source: string, allowUrls = false): string[] {
  return NETWORK_APIS.filter(([name]) => !(allowUrls && name === 'an absolute URL'))
    .filter(([, pattern]) => pattern.test(source))
    .map(([name]) => name);
}

/** What is wrong with a tool page: it must be a `ToolFrame` and must not bring its own `<h1>`. */
function frameProblems(source: string): string[] {
  const problems: string[] = [];
  if (!/<ToolFrame[\s>]/.test(source)) {
    problems.push('does not render <ToolFrame>');
  }
  if (/<h1[\s>]/.test(source)) {
    problems.push('renders its own <h1>');
  }
  return problems;
}

function walk(dir: string, extensions: readonly string[]): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' ? [] : walk(path, extensions);
    }
    return extensions.some((extension) => entry.name.endsWith(extension)) ? [path] : [];
  });
}

// `src/pdf` is the code the PDF tools share (workers, engine, page grid): the same rule applies.
const toolSources = ['tools', 'pdf'].flatMap((dir) =>
  walk(join(appRoot, 'src', dir), ['.ts', '.svelte']),
);
const packageSources = walk(join(appRoot, '..', '..', 'packages', 'tools', 'src'), ['.ts']);

describe('the rule "a tool never sends file content" (checker)', () => {
  it.each([
    ['fetch("/x", { method: "POST", body })', 'fetch()'],
    ['await fetch(url)', 'fetch()'],
    ['const r = new XMLHttpRequest()', 'XMLHttpRequest'],
    ['navigator.sendBeacon("/log", data)', 'navigator.sendBeacon'],
    ['new WebSocket("wss://example.org")', 'WebSocket'],
    ['new EventSource(url)', 'EventSource'],
    ['new RTCPeerConnection()', 'RTCPeerConnection'],
    ['new WebTransport(url)', 'WebTransport'],
    ['const u = "https://example.org/x"', 'an absolute URL'],
    ['const u = "http://example.org/x"', 'an absolute URL'],
  ])('flags %s', (source, name) => {
    expect(networkUse(source)).toContain(name);
  });

  it.each([
    'const refetch = 1',
    'fetched.push(a)',
    'self.fetchLater',
    'worker.postMessage({ type: "run" })',
    'new URL("./worker.ts", import.meta.url)',
    'const note = "files stay in the browser"',
  ])('lets %s through', (source) => {
    expect(networkUse(source)).toEqual([]);
  });

  it('can leave URLs alone (the package documents http:// in a comment)', () => {
    expect(networkUse('// plain http://host', true)).toEqual([]);
    expect(networkUse('fetch(x)', true)).toEqual(['fetch()']);
  });
});

describe('the rule "a tool never sends file content" (the sources)', () => {
  it('holds for every file under src/tools and src/pdf', () => {
    const found = toolSources.flatMap((path) =>
      networkUse(readFileSync(path, 'utf8')).map((name) => `${relative(appRoot, path)}: ${name}`),
    );
    expect(found).toEqual([]);
  });

  it('holds for the worker pool and everything else in packages/tools/src', () => {
    expect(packageSources.length).toBeGreaterThan(8);
    const found = packageSources.flatMap((path) =>
      networkUse(readFileSync(path, 'utf8'), true).map((name) => `${path}: ${name}`),
    );
    expect(found).toEqual([]);
  });

  it('holds for everything the scaffold generates', () => {
    for (const worker of [false, true]) {
      const { files } = renderTool({
        id: 'merge-pdf',
        category: 'pdf',
        sticker: 'pdf-merge',
        name: 'Merge PDFs',
        worker,
      });
      for (const [path, source] of Object.entries(files)) {
        expect(networkUse(source), path).toEqual([]);
      }
    }
  });

  it('is not vacuous: the scan really reads source files', () => {
    expect(toolSources.some((path) => path.endsWith('define.ts'))).toBe(true);
  });
});

describe('the rule "every tool page is a ToolFrame with one h1" (checker)', () => {
  it('accepts a page that is a frame', () => {
    expect(frameProblems('<ToolFrame id="x"><p>body</p></ToolFrame>')).toEqual([]);
    expect(frameProblems('<ToolFrame id="x" />')).toEqual([]);
  });

  it('flags a page without the frame and a page with its own h1', () => {
    expect(frameProblems('<h2>x</h2>')).toEqual(['does not render <ToolFrame>']);
    expect(frameProblems('<ToolFrame id="x"><h1>Again</h1></ToolFrame>')).toEqual([
      'renders its own <h1>',
    ]);
    expect(frameProblems('<h1 class="a">x</h1>')).toEqual([
      'does not render <ToolFrame>',
      'renders its own <h1>',
    ]);
  });

  it('does not mistake other tags for the frame or the heading', () => {
    expect(frameProblems('<ToolFrameBox></ToolFrameBox><h10>x</h10>')).toEqual([
      'does not render <ToolFrame>',
    ]);
  });
});

describe('the rule "every tool page is a ToolFrame with one h1" (the sources)', () => {
  const pages = toolSources.filter((path) => path.endsWith('Tool.svelte'));

  it.each(pages.map((path) => [relative(appRoot, path), path] as const))(
    '%s is a frame',
    (_name, path) => {
      expect(frameProblems(readFileSync(path, 'utf8'))).toEqual([]);
    },
  );

  it('holds for the page the scaffold generates', () => {
    const page = renderTool({
      id: 'merge-pdf',
      category: 'pdf',
      sticker: 'pdf-merge',
      name: 'Merge PDFs',
      worker: false,
    }).files['src/tools/merge-pdf/Tool.svelte'];
    expect(frameProblems(page ?? '')).toEqual([]);
  });

  it('every tool directory has a Tool.svelte next to its manifest', () => {
    const directories = readdirSync(join(appRoot, 'src', 'tools'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    for (const directory of directories) {
      expect(
        readdirSync(join(appRoot, 'src', 'tools', directory)),
        `src/tools/${directory}`,
      ).toEqual(expect.arrayContaining(['manifest.ts', 'Tool.svelte']));
    }
  });
});

describe('the privacy promise in the shipped manifests', () => {
  const manifests = import.meta.glob<{ default: { fileContent: unknown; runsIn: unknown } }>(
    '../src/tools/*/manifest.ts',
    { eager: true },
  );

  it('is "stays-in-browser" and "client" in every manifest under src/tools', () => {
    for (const [path, module] of Object.entries(manifests)) {
      expect(module.default.fileContent, path).toBe('stays-in-browser');
      expect(module.default.runsIn, path).toBe('client');
    }
  });
});
