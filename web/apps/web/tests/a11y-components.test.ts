import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import axe, { type AxeResults, type Result } from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import Gallery from '../src/gallery/Gallery.svelte';
import { toaster } from '../src/ui/toast.svelte.ts';
import { formatViolations, GATE_TAGS } from '../e2e/support/axe-report.ts';
import sampleTool from './fixtures/sample-tool/manifest.ts';
import { SAMPLE_CATALOGS } from './fixtures/sample-tool/messages.ts';
import { openTool } from './tool-helpers.ts';

// The component half of the accessibility gate (T-05, #13): axe on rendered components in jsdom,
// next to the Playwright runs that scan the built app in two real browsers. jsdom has no layout
// and no painting, so the rules that need them (contrast, target size, visibility of landmarks)
// are the Playwright half's job; everything about names, roles, ARIA, labels, headings, lists and
// landmarks is checked here, on every component and on every state a unit test can reach.

afterEach(() => {
  toaster.clear();
});

/** Rules that cannot give a result without a rendering engine. */
const NEEDS_A_BROWSER = ['color-contrast', 'target-size', 'scrollable-region-focusable'] as const;

async function scan(root: Element): Promise<AxeResults> {
  return axe.run(root, {
    runOnly: { type: 'tag', values: [...GATE_TAGS] },
    rules: Object.fromEntries(NEEDS_A_BROWSER.map((id) => [id, { enabled: false }])),
  });
}

async function expectNoViolations(label: string, root: Element): Promise<void> {
  const { violations } = await scan(root);
  expect(formatViolations(label, violations), label).toBe('');
}

describe('axe in a component test', () => {
  it('finds a violation (the gate can fail here as well)', async () => {
    const host = document.createElement('div');
    host.innerHTML = '<main><img src="x.png"><button></button><input type="text"></main>';
    document.body.append(host);
    const { violations } = await scan(host);
    host.remove();
    const ids = violations.map((violation) => violation.id);
    expect(ids).toEqual(expect.arrayContaining(['image-alt', 'button-name', 'label']));
  });

  it('runs the WCAG 2.2 AA set: the rules the issue names are part of the gate', () => {
    const ids = new Set(axe.getRules([...GATE_TAGS]).map((rule) => rule.ruleId));
    for (const id of [
      'color-contrast',
      'target-size',
      'image-alt',
      'button-name',
      'link-name',
      'label',
      'aria-valid-attr',
      'html-has-lang',
      'document-title',
      'landmark-one-main',
      'page-has-heading-one',
      'heading-order',
      'region',
    ]) {
      expect(ids.has(id), `rule ${id} is in the gate`).toBe(true);
    }
    // WCAG 2.2 (target size) is in, so is the 2.1 AA set (reflow, text spacing, ...).
    expect(GATE_TAGS).toEqual(expect.arrayContaining(['wcag22aa', 'wcag21aa', 'wcag2aa']));
  });
});

describe('formatViolations', () => {
  const violation = (overrides: Partial<Result> = {}): Result =>
    ({
      id: 'image-alt',
      impact: 'critical',
      description: 'Images must have alternative text',
      help: 'Images must have alternative text',
      helpUrl: 'https://dequeuniversity.com/rules/axe/4.14/image-alt',
      tags: ['wcag2a'],
      nodes: [
        {
          html: '<img src="a.png">',
          target: ['img'],
          impact: 'critical',
          failureSummary: 'Fix any of the following:\n  Element does not have an alt attribute',
        },
      ],
      ...overrides,
    }) as Result;

  it('is empty for a clean page', () => {
    expect(formatViolations('home', [])).toBe('');
  });

  it('names the state, the rule, the impact, where it is and how to read up on it', () => {
    const report = formatViolations('home', [violation()]);
    expect(report).toContain('1 accessibility violation(s) in "home"');
    expect(report).toContain('- image-alt (critical): Images must have alternative text');
    expect(report).toContain('https://dequeuniversity.com/rules/axe/4.14/image-alt');
    expect(report).toContain('at img');
    expect(report).toContain('<img src="a.png">');
    expect(report).toContain('Element does not have an alt attribute');
  });

  it('writes the selector path of a node inside frames or shadow roots with a separator', () => {
    const node = {
      html: '<b></b>',
      target: ['iframe', 'main > b'],
      impact: 'minor',
    } as unknown as Result['nodes'][number];
    expect(formatViolations('x', [violation({ nodes: [node] })])).toContain(
      'at iframe >> main > b',
    );
  });

  it('says "unrated" without an impact and skips a missing failure summary', () => {
    const node = { html: '<b></b>', target: ['b'] } as unknown as Result['nodes'][number];
    const report = formatViolations('x', [violation({ impact: null, nodes: [node] })]);
    expect(report).toContain('(unrated)');
    expect(report).not.toContain('undefined');
  });

  it('lists five nodes of a rule and counts the rest', () => {
    const nodes = Array.from({ length: 8 }, (_, index) => ({
      html: `<img id="i${String(index)}">`,
      target: [`#i${String(index)}`],
      impact: 'critical',
    })) as unknown as Result['nodes'];
    const report = formatViolations('x', [violation({ nodes })]);
    expect(report).toContain('#i4');
    expect(report).not.toContain('#i5');
    expect(report).toContain('... and 3 more');
  });

  it('cuts a long element to 160 characters', () => {
    const html = `<p>${'a'.repeat(400)}</p>`;
    const node = { html, target: ['p'], impact: 'minor' } as unknown as Result['nodes'][number];
    const report = formatViolations('x', [violation({ nodes: [node] })]);
    expect(report).toContain(html.slice(0, 160));
    expect(report).not.toContain(html.slice(0, 161));
  });

  it('counts every violation', () => {
    const report = formatViolations('x', [violation(), violation({ id: 'label' })]);
    expect(report).toContain('2 accessibility violation(s)');
    expect(report).toContain('- label (');
  });
});

describe('the base components', () => {
  it('the gallery, which shows every component, has no violation', async () => {
    const { container } = render(Gallery);
    await expectNoViolations('gallery', container);
  });

  it('the gallery with an open dialog', async () => {
    const { container } = render(Gallery);
    await userEvent.click(screen.getByRole('button', { name: 'Open dialog' }));
    await expectNoViolations('gallery, dialog open', container);
  });

  it('the gallery with a toast of every kind', async () => {
    const { container } = render(Gallery);
    for (const kind of ['info', 'success', 'warn', 'error']) {
      await userEvent.click(screen.getByRole('button', { name: kind }));
    }
    expect(await screen.findAllByText(/A \w+ message/)).toHaveLength(4);
    await expectNoViolations('gallery, four toasts', container);
  });

  it('the gallery with another tab selected', async () => {
    const { container } = render(Gallery);
    await userEvent.click(screen.getByRole('tab', { name: 'XML' }));
    await expectNoViolations('gallery, XML tab', container);
  });
});

describe('the shell', () => {
  it('a tool page: landmarks, one h1, the privacy note', async () => {
    const view = await openTool(sampleTool, SAMPLE_CATALOGS);
    await expectNoViolations('tool page', document.body);
    expect(view.headings).toHaveLength(1);
  });

  it('the search dialog with a hit', async () => {
    await openTool(sampleTool, SAMPLE_CATALOGS);
    await userEvent.click(screen.getByRole('button', { name: /^Search tools/ }));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search' }), 'sample');
    await screen.findByRole('link', { name: /Sample tool/ });
    await expectNoViolations('search dialog', document.body);
  });
});
