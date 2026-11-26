import { CODE_ART, isCodeArt } from '@mozra-the-great/kern';
import { STICKER_NAMES } from '@stuffcloud/tools';
import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import Sticker from '../src/app/Sticker.svelte';
import { stickerArt, stickerScale, stickerUrl } from '../src/app/stickers.ts';
import { CAPABILITY_LABELS, searchTools } from '../src/app/tools.ts';
import { CAPABILITIES } from '@stuffcloud/tools';
import { en } from '../src/i18n/messages/en.ts';
import { de } from '../src/i18n/messages/de.ts';
import { makeTool } from './app-helpers.ts';
import { must } from './app-helpers.ts';
import { readRepoFile } from './helpers.ts';

describe('stickerUrl', () => {
  it('resolves every design sticker to its own file', () => {
    for (const name of STICKER_NAMES) {
      expect(stickerUrl(name), name).toMatch(new RegExp(`sticker-${name}[^/]*\\.svg`));
    }
    expect(new Set(STICKER_NAMES.map((name) => stickerUrl(name))).size).toBe(STICKER_NAMES.length);
  });

  it('does not mix up a sticker with one whose name it is a prefix of', () => {
    expect(stickerUrl('img-resize')).not.toBe(stickerUrl('img-crop'));
    expect(stickerUrl('pdf-merge')).toContain('pdf-merge');
  });

  it('throws when the file is missing from the build, naming it', () => {
    expect(() => stickerUrl('qr', {})).toThrow('sticker art for qr is missing: sticker-qr.svg');
  });

  it('uses the url map it is given', () => {
    const url = stickerUrl('qr', {
      '../../../../../docs/design/prototypes/sticker-qr.svg': '/x.svg',
    });
    expect(url).toBe('/x.svg');
  });
});

describe('stickerArt', () => {
  it("is kern's code art for every design sticker, with the grid of the design's SVG", () => {
    for (const name of STICKER_NAMES) {
      const art = stickerArt(name);
      expect(art, name).toBe(`tool-stickers/sticker-${name}`);
      expect(isCodeArt(art), `kern has code art for ${name}`).toBe(true);
      const grid = CODE_ART[art];
      expect(readRepoFile(`docs/design/prototypes/sticker-${name}.svg`), name).toContain(
        `viewBox="0 0 ${String(grid.cols)} ${String(grid.rows)}"`,
      );
    }
  });
});

describe('stickerScale', () => {
  it('picks the whole number of pixels per art pixel closest to the wanted height', () => {
    expect(stickerScale(48, 12)).toBe(4);
    expect(stickerScale(48, 9)).toBe(5);
    expect(stickerScale(48, 5)).toBe(10);
    expect(stickerScale(24, 12)).toBe(2);
    expect(stickerScale(48, 11)).toBe(4);
  });

  it('never goes below one pixel per art pixel', () => {
    expect(stickerScale(4, 12)).toBe(1);
    expect(stickerScale(0, 12)).toBe(1);
  });
});

describe('Sticker', () => {
  it('renders a decorative, still pixel image of the right file at a whole scale', () => {
    const { container } = render(Sticker, { name: 'pdf-merge' });
    const image = must(container.querySelector('img'));
    const grid = CODE_ART[stickerArt('pdf-merge')];
    expect(image.getAttribute('src')).toBe(stickerUrl('pdf-merge'));
    expect(image.getAttribute('alt')).toBe('');
    expect(image.getAttribute('aria-hidden')).toBe('true');
    expect(Number(image.getAttribute('height'))).toBe(grid.rows * stickerScale(48, grid.rows));
    expect(Number(image.getAttribute('width'))).toBe(grid.cols * stickerScale(48, grid.rows));
    expect(container.querySelector('.k-mascot')?.getAttribute('data-motion')).toBe('still');
  });

  it('takes another size', () => {
    const { container } = render(Sticker, { name: 'qr', size: 24 });
    const grid = CODE_ART[stickerArt('qr')];
    expect(container.querySelector('img')?.getAttribute('height')).toBe(
      String(grid.rows * stickerScale(24, grid.rows)),
    );
  });
});

describe('capability labels', () => {
  it('have a message in both catalogues for every capability', () => {
    expect(Object.keys(CAPABILITY_LABELS).toSorted()).toEqual([...CAPABILITIES].toSorted());
    for (const capability of CAPABILITIES) {
      const key = CAPABILITY_LABELS[capability];
      expect(typeof en[key]).toBe('string');
      expect(typeof de[key]).toBe('string');
    }
  });
});

describe('searchTools with keywords', () => {
  const base = makeTool('qr-code', 'text', 'QR code', 'QR-Code');
  const tool = {
    ...base,
    keywords: { en: 'barcode scan', de: 'Strichcode Prüfung' },
  };

  it('finds a tool by a keyword of either language, ignoring case and accents', () => {
    expect(searchTools([tool], 'BARCODE', 'en')).toEqual([tool]);
    expect(searchTools([tool], 'strichcode', 'en')).toEqual([tool]);
    expect(searchTools([tool], 'pruefung', 'en')).toEqual([]);
    expect(searchTools([tool], 'prufung', 'en')).toEqual([tool]);
  });

  it('needs every word to match somewhere in id, name or keywords', () => {
    expect(searchTools([tool], 'qr barcode', 'en')).toEqual([tool]);
    expect(searchTools([tool], 'qr nonsense', 'en')).toEqual([]);
  });

  it('does not search the description', () => {
    expect(searchTools([tool], 'description', 'en')).toEqual([]);
  });
});
