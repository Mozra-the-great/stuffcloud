import { describe, expect, it } from 'vitest';
import {
  ALLOWED,
  MAX_MARKDOWN_CHARS,
  previewLevels,
  renderMarkdown,
  toPreview,
  type PreviewLabels,
} from '../../src/tools/markdown/render.ts';
import { PAYLOADS } from '../../e2e/support/xss-payloads.ts';

const labels: PreviewLabels = {
  blockedImage: (alt) => (alt === '' ? '[picture not loaded]' : `[picture not loaded: ${alt}]`),
  taskDone: 'done',
  taskOpen: 'open',
};

function dom(html: string): Document {
  return new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
}

/** Everything in `html` that a safe document may not contain. */
function violations(html: string, extra: readonly string[] = []): string[] {
  const found: string[] = [];
  for (const element of dom(html).body.querySelectorAll('*')) {
    const tag = element.localName;
    if (!ALLOWED.tags.includes(tag)) {
      found.push(`tag <${tag}>`);
    }
    for (const attribute of element.attributes) {
      const name = attribute.name;
      if (!ALLOWED.attributes.includes(name) && !extra.includes(name)) {
        found.push(`attribute ${name} on <${tag}>`);
      }
      let value = '';
      for (let index = 0; index < attribute.value.length; index += 1) {
        if (attribute.value.charCodeAt(index) > 32) {
          value += attribute.value.charAt(index);
        }
      }
      if (name === 'href' && !/^(?:https?:|mailto:)/i.test(value)) {
        found.push(`href ${value}`);
      }
      if (
        name === 'src' &&
        !/^(?:https?:|data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,)/i.test(value)
      ) {
        found.push(`src ${value}`);
      }
    }
    if (tag === 'input' && element.getAttribute('type') !== 'checkbox') {
      found.push('input that is not a checkbox');
    }
  }
  return found;
}

/** What the page would be given: the preview's nodes, as a string. */
function previewHtml(html: string): string {
  const holder = document.createElement('div');
  holder.append(...toPreview(html, labels).nodes);
  return holder.innerHTML;
}

describe('renderMarkdown: Markdown features', () => {
  it('renders the text elements', () => {
    expect(renderMarkdown('# T\n\nText with **bold**, *italic*, `code` and ~~gone~~.')).toBe(
      '<h1>T</h1>\n<p>Text with <strong>bold</strong>, <em>italic</em>, <code>code</code> and <del>gone</del>.</p>\n',
    );
  });

  it('renders lists, quotes, rules and code blocks', () => {
    const html = renderMarkdown(
      '- a\n- b\n\n1. x\n2. y\n\n> quote\n\n---\n\n```js\nlet a = 1 < 2;\n```',
    );
    expect(html).toContain('<ul>\n<li>a</li>\n<li>b</li>\n</ul>');
    expect(html).toContain('<ol>\n<li>x</li>\n<li>y</li>\n</ol>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<hr>');
    // The language class is dropped with every other class: no class, no style, no id survives.
    expect(html).toContain('<pre><code>let a = 1 &lt; 2;');
    expect(html).not.toContain('class=');
    expect(html).toContain('let a = 1 &lt; 2;');
  });

  it('renders GitHub tables with alignment', () => {
    const html = renderMarkdown('| a | b |\n|:--|--:|\n| 1 | 2 |');
    const table = dom(html).querySelector('table');
    expect(table?.querySelectorAll('th')).toHaveLength(2);
    expect(table?.querySelector('th')?.getAttribute('align')).toBe('left');
    expect(table?.querySelectorAll('th')[1]?.getAttribute('align')).toBe('right');
    expect([...(table?.querySelectorAll('td') ?? [])].map((cell) => cell.textContent)).toEqual([
      '1',
      '2',
    ]);
  });

  it('renders task lists as disabled checkboxes', () => {
    const doc = dom(renderMarkdown('- [x] done\n- [ ] open'));
    const boxes = [...doc.querySelectorAll('input')];
    expect(boxes.map((box) => box.getAttribute('type'))).toEqual(['checkbox', 'checkbox']);
    expect(boxes.every((box) => box.hasAttribute('disabled'))).toBe(true);
    expect(boxes.map((box) => box.hasAttribute('checked'))).toEqual([true, false]);
  });

  it('renders links, autolinks and mail addresses', () => {
    const doc = dom(
      renderMarkdown('[a](https://example.org/x "t") https://example.net/y <me@example.com>'),
    );
    expect([...doc.querySelectorAll('a')].map((link) => link.getAttribute('href'))).toEqual([
      'https://example.org/x',
      'https://example.net/y',
      'mailto:me@example.com',
    ]);
  });

  it('lets harmless HTML through', () => {
    const html = renderMarkdown(
      '<details open><summary>More</summary>text <kbd>Ctrl</kbd> <mark>m</mark></details>',
    );
    expect(html).toContain('<details open="">');
    expect(html).toContain('<kbd>Ctrl</kbd>');
    expect(violations(html)).toEqual([]);
  });

  it('renders an empty text as nothing', () => {
    expect(renderMarkdown('')).toBe('');
  });

  it('has a limit for the page to apply', () => {
    expect(MAX_MARKDOWN_CHARS).toBe(1_000_000);
  });
});

describe('XSS corpus', () => {
  it.each(PAYLOADS)('is made safe: %s', (payload) => {
    const html = renderMarkdown(payload);
    expect(violations(html)).toEqual([]);
    expect(html).not.toMatch(/<script/i);
    const shown = previewHtml(html);
    expect(violations(shown, ['target', 'rel', 'aria-label', 'class'])).toEqual([]);
    // Nothing the preview adds to the page loads from the internet.
    const holder = document.createElement('div');
    holder.append(...toPreview(html, labels).nodes);
    for (const image of holder.querySelectorAll('img')) {
      expect(image.getAttribute('src')).toMatch(/^data:image\//);
    }
    for (const link of holder.querySelectorAll('a[href]')) {
      expect(link.getAttribute('href')).toMatch(/^(?:https?:|mailto:)/i);
    }
  });

  it('keeps the text of a payload as text, so that it can be read, not run', () => {
    expect(renderMarkdown('`<script>alert(1)</script>`')).toBe(
      '<p><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></p>\n',
    );
    expect(renderMarkdown('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    );
  });

  it('drops the whole content of a script, a style and a template', () => {
    expect(renderMarkdown('<script>alert(1)</script>after')).not.toContain('alert');
    expect(renderMarkdown('<style>body{color:red}</style>after')).not.toContain('color');
    expect(renderMarkdown('<template><b>x</b></template>after')).not.toContain('<b>');
  });

  it('removes the link of a javascript: URL but keeps its text', () => {
    expect(renderMarkdown('[click](javascript:alert(1))')).toBe('<p><a>click</a></p>\n');
    expect(renderMarkdown('<a href="java&#9;script:alert(1)">click</a>')).toBe(
      '<p><a>click</a></p>' + String.fromCharCode(10),
    );
  });

  it('keeps a link to the internet and to a mail address', () => {
    expect(renderMarkdown('[a](https://example.org/?q=1&r=2)')).toBe(
      '<p><a href="https://example.org/?q=1&amp;r=2">a</a></p>\n',
    );
    expect(renderMarkdown('[m](mailto:me@example.com)')).toBe(
      '<p><a href="mailto:me@example.com">m</a></p>\n',
    );
  });

  it('removes a link that points nowhere useful: relative, fragment, protocol-relative, file', () => {
    for (const target of [
      'page.html',
      '#top',
      '//example.org',
      'file:///x',
      'ftp://example.org/x',
      'tel:123',
    ]) {
      expect(renderMarkdown(`[a](${target})`)).toBe('<p><a>a</a></p>\n');
    }
  });

  it('keeps no sanitiser state between two documents', () => {
    expect(renderMarkdown('<script>x</script><b>1</b>')).toBe('<b>1</b>');
    expect(renderMarkdown('<b>2</b>')).toBe('<p><b>2</b></p>' + String.fromCharCode(10));
  });
});

describe('images in the sanitised HTML', () => {
  it('keeps the source of a picture from the internet, for copying', () => {
    expect(renderMarkdown('![A cat](https://example.org/cat.png "Cat")')).toBe(
      '<p><img src="https://example.org/cat.png" alt="A cat" title="Cat"></p>\n',
    );
  });

  it('keeps an inline raster picture and drops every other data: source', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    expect(renderMarkdown(`![x](${png})`)).toBe(`<p><img src="${png}" alt="x"></p>\n`);
    for (const source of [
      'data:image/svg+xml;base64,PHN2Zz4=',
      'data:image/png,not-base64',
      'data:text/html;base64,PHA+',
      'file:///x.png',
      'ftp://example.org/x.png',
      '/relative.png',
    ]) {
      expect(
        dom(renderMarkdown(`<img src="${source}" alt="y">`))
          .querySelector('img')
          ?.hasAttribute('src'),
      ).toBe(false);
    }
  });
});

describe('toPreview', () => {
  it('replaces a picture from the internet by its description and counts it', () => {
    const preview = toPreview(
      renderMarkdown('![A cat](https://example.org/cat.png) and ![](https://example.net/b.png)'),
      labels,
    );
    const holder = document.createElement('div');
    holder.append(...preview.nodes);
    expect(preview.blockedImages).toBe(2);
    expect(holder.querySelector('img')).toBeNull();
    expect([...holder.querySelectorAll('.blocked-image')].map((span) => span.textContent)).toEqual([
      '[picture not loaded: A cat]',
      '[picture not loaded]',
    ]);
  });

  it('keeps an inline picture and does not count it', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const preview = toPreview(renderMarkdown(`![x](${png})`), labels);
    const holder = document.createElement('div');
    holder.append(...preview.nodes);
    expect(preview.blockedImages).toBe(0);
    expect(holder.querySelector('img')?.getAttribute('src')).toBe(png);
  });

  it('replaces a picture without a usable source, and does not count it', () => {
    const preview = toPreview(renderMarkdown('![x](javascript:alert(1)) <img alt="y">'), labels);
    expect(preview.blockedImages).toBe(0);
    expect(previewHtml(renderMarkdown('<img alt="y">'))).toBe(
      '<span class="blocked-image">[picture not loaded: y]</span>',
    );
  });

  it('opens links in a new tab without a referrer', () => {
    const holder = document.createElement('div');
    holder.append(...toPreview(renderMarkdown('[a](https://example.org) <a>b</a>'), labels).nodes);
    const [first, second] = holder.querySelectorAll('a');
    expect(first?.getAttribute('target')).toBe('_blank');
    expect(first?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(second?.hasAttribute('target')).toBe(false);
  });

  it('names the checkboxes of a task list', () => {
    const holder = document.createElement('div');
    holder.append(...toPreview(renderMarkdown('- [x] a\n- [ ] b'), labels).nodes);
    expect(
      [...holder.querySelectorAll('input')].map((box) => box.getAttribute('aria-label')),
    ).toEqual(['done', 'open']);
  });

  it('keeps the outline in order: the headings start at level 3 and never skip a level', () => {
    const holder = document.createElement('div');
    holder.append(
      ...toPreview(renderMarkdown('# a\n\n##### b\n\n## c\n\n###### d\n\n# e'), labels).nodes,
    );
    expect(
      [...holder.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((heading) => heading.nodeName),
    ).toEqual(['H3', 'H4', 'H4', 'H5', 'H3']);
    expect(holder.querySelector('h3')?.textContent).toBe('a');
  });

  it('gives the page nodes of its own document', () => {
    const [node] = toPreview('<p>x</p>', labels).nodes;
    expect(node?.ownerDocument).toBe(document);
  });
});

describe('previewLevels', () => {
  it('moves the outline below the tool heading without a gap', () => {
    expect(previewLevels([])).toEqual([]);
    expect(previewLevels([1])).toEqual([3]);
    expect(previewLevels([2])).toEqual([3]);
    expect(previewLevels([4])).toEqual([3]);
    expect(previewLevels([1, 2, 3])).toEqual([3, 4, 5]);
    expect(previewLevels([1, 6])).toEqual([3, 4]);
    expect(previewLevels([1, 2, 3, 4, 5, 6])).toEqual([3, 4, 5, 6, 6, 6]);
    expect(previewLevels([3, 1, 5])).toEqual([3, 3, 4]);
  });

  it('never skips a level whatever the headings', () => {
    let state = 5;
    for (let round = 0; round < 200; round += 1) {
      const levels = Array.from({ length: 8 }, () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return 1 + (state % 6);
      });
      const shifted = previewLevels(levels);
      expect(shifted[0]).toBeLessThanOrEqual(3);
      shifted.forEach((level, index) => {
        expect(level).toBeGreaterThanOrEqual(3);
        expect(level).toBeLessThanOrEqual(6);
        if (index > 0) {
          expect(level).toBeLessThanOrEqual((shifted[index - 1] ?? 0) + 1);
        }
      });
    }
  });
});
