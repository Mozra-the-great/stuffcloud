import { afterEach, describe, expect, it } from 'vitest';
import { documentTitle, focusHeading, headingText, pageHeading } from '../src/app/focus.ts';
import { isSearchShortcut, searchShortcutLabel } from '../src/app/shortcut.ts';
import {
  CATEGORY_LABELS,
  TOOL_CATEGORIES,
  foldText,
  isToolCategory,
  searchTools,
  toolPath,
  toolsInCategory,
  usedCategories,
} from '../src/app/tools.ts';
import { en } from '../src/i18n/messages/en.ts';
import { makeTool } from './app-helpers.ts';

afterEach(() => {
  document.body.replaceChildren();
});

describe('tools helpers', () => {
  const merge = makeTool('merge-pdf', 'pdf', 'Merge PDFs', 'PDFs zusammenfügen');
  const resize = makeTool('resize-image', 'image', 'Resize image', 'Bild verkleinern');
  const umlaut = makeTool('over', 'text', 'Over', 'Über');
  const all = [merge, resize, umlaut];

  it('lists the categories of SPEC 7 and a label key for each', () => {
    expect(TOOL_CATEGORIES).toEqual([
      'pdf',
      'image',
      'convert',
      'parse',
      'network',
      'text',
      'extra',
    ]);
    for (const category of TOOL_CATEGORIES) {
      expect(Object.hasOwn(en, CATEGORY_LABELS[category])).toBe(true);
    }
  });

  it('recognises category names', () => {
    expect(isToolCategory('pdf')).toBe(true);
    expect(isToolCategory('PDF')).toBe(false);
    expect(isToolCategory('')).toBe(false);
  });

  it('builds the deep link of a tool', () => {
    expect(toolPath('merge-pdf')).toBe('/tools/merge-pdf');
    expect(toolPath('a b')).toBe('/tools/a%20b');
  });

  it('filters by category and keeps the order', () => {
    expect(toolsInCategory(all, undefined)).toEqual(all);
    expect(toolsInCategory(all, 'image')).toEqual([resize]);
    expect(toolsInCategory(all, 'network')).toEqual([]);
  });

  it('lists only categories that have tools, in navigation order', () => {
    expect(usedCategories(all)).toEqual(['pdf', 'image', 'text']);
    expect(usedCategories([])).toEqual([]);
  });

  it('folds case and diacritics', () => {
    expect(foldText('Über ÄÖ')).toBe('uber ao');
  });

  describe('searchTools', () => {
    it('finds by id and by the name in either language', () => {
      expect(searchTools(all, 'merge', 'en')).toEqual([merge]);
      expect(searchTools(all, 'zusammen', 'en')).toEqual([merge]);
      expect(searchTools(all, 'verkleinern', 'de')).toEqual([resize]);
      expect(searchTools(all, 'resize-image', 'en')).toEqual([resize]);
    });

    it('ignores case and diacritics', () => {
      expect(searchTools(all, 'UBER', 'de')).toEqual([umlaut]);
      expect(searchTools(all, 'über', 'en')).toEqual([umlaut]);
    });

    it('requires every word of the query', () => {
      expect(searchTools(all, 'merge pdfs', 'en')).toEqual([merge]);
      expect(searchTools(all, 'merge image', 'en')).toEqual([]);
    });

    it('finds nothing for an empty or blank query', () => {
      expect(searchTools(all, '', 'en')).toEqual([]);
      expect(searchTools(all, '   ', 'en')).toEqual([]);
    });

    it('sorts by the name in the language of the page', () => {
      const a = makeTool('t-a', 'text', 'Zebra', 'Ameise');
      const b = makeTool('t-b', 'text', 'Apple', 'Zitrone');
      expect(searchTools([a, b], 't-', 'en')).toEqual([b, a]);
      expect(searchTools([a, b], 't-', 'de')).toEqual([a, b]);
    });

    it('does not change the list it was given', () => {
      const list = [resize, merge];
      searchTools(list, 'e', 'en');
      expect(list).toEqual([resize, merge]);
    });
  });
});

describe('focus helpers', () => {
  function mainWith(html: string): HTMLElement {
    const main = document.createElement('main');
    main.innerHTML = html;
    document.body.append(main);
    return main;
  }

  it('finds the page heading and its text', () => {
    const main = mainWith('<h2>no</h2><h1> Tools </h1>');
    expect(pageHeading(main)?.textContent).toBe(' Tools ');
    expect(headingText(main)).toBe('Tools');
  });

  it('has no heading text without a heading', () => {
    const main = mainWith('<p>x</p>');
    expect(pageHeading(main)).toBeNull();
    expect(headingText(main)).toBe('');
  });

  it('focuses the heading and makes it focusable without a tab stop', () => {
    const main = mainWith('<h1>Tools</h1>');
    focusHeading(main);
    expect(document.activeElement).toBe(main.querySelector('h1'));
    expect(main.querySelector('h1')?.getAttribute('tabindex')).toBe('-1');
  });

  it('keeps a tabindex the heading already has', () => {
    const main = mainWith('<h1 tabindex="0">Tools</h1>');
    focusHeading(main);
    expect(main.querySelector('h1')?.getAttribute('tabindex')).toBe('0');
  });

  it('falls back to the main element when there is no heading', () => {
    const main = mainWith('<p>x</p>');
    focusHeading(main);
    expect(document.activeElement).toBe(main);
    expect(main.getAttribute('tabindex')).toBe('-1');
  });

  it('builds the tab title', () => {
    expect(documentTitle('Tools')).toBe('Tools · stuffcloud');
    expect(documentTitle('')).toBe('stuffcloud');
    expect(documentTitle('stuffcloud')).toBe('stuffcloud');
  });
});

describe('search shortcut', () => {
  const key = { key: 'k', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };

  it('is Ctrl+K or Cmd+K', () => {
    expect(isSearchShortcut({ ...key, ctrlKey: true })).toBe(true);
    expect(isSearchShortcut({ ...key, metaKey: true })).toBe(true);
    expect(isSearchShortcut({ ...key, ctrlKey: true, key: 'K' })).toBe(true);
  });

  it('is not a bare key or another combination', () => {
    expect(isSearchShortcut(key)).toBe(false);
    expect(isSearchShortcut({ ...key, ctrlKey: true, key: 'j' })).toBe(false);
    expect(isSearchShortcut({ ...key, ctrlKey: true, altKey: true })).toBe(false);
    expect(isSearchShortcut({ ...key, ctrlKey: true, shiftKey: true })).toBe(false);
  });

  it('shows the key of the platform', () => {
    expect(searchShortcutLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')).toBe('⌘K');
    expect(searchShortcutLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)')).toBe('⌘K');
    expect(searchShortcutLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('Ctrl K');
    expect(searchShortcutLabel('Mozilla/5.0 (X11; Linux x86_64)')).toBe('Ctrl K');
  });
});

describe('tool context', () => {
  it('refuses to be read without a provider', async () => {
    const { default: Probe } = await import('./ContextProbe.svelte');
    const { render } = await import('@testing-library/svelte');
    expect(() => render(Probe)).toThrow('getTools() needs a parent that called provideTools()');
  });
});
