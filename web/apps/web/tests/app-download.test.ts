import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveBlob, saveText } from '../src/app/download.ts';

const made: Blob[] = [];
const revoked: string[] = [];
const clicks: { href: string; download: string; rel: string; connected: boolean }[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: (blob: Blob): string => {
      made.push(blob);
      return `blob:download/${String(made.length)}`;
    },
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: (url: string): void => {
      revoked.push(url);
    },
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(
    this: HTMLAnchorElement,
  ) {
    clicks.push({
      href: this.href,
      download: this.download,
      rel: this.rel,
      connected: this.isConnected,
    });
  });
});

afterEach(() => {
  made.length = 0;
  revoked.length = 0;
  clicks.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('saveBlob', () => {
  it('clicks a link to an object URL of the blob, then removes the link and gives the URL back', () => {
    const blob = new Blob(['x'], { type: 'image/png' });
    saveBlob('picture.png', blob);
    expect(made).toEqual([blob]);
    expect(clicks).toEqual([
      { href: 'blob:download/1', download: 'picture.png', rel: 'noopener', connected: true },
    ]);
    expect(document.querySelector('a[download]')).toBeNull();
    // The URL stays valid until the click has been handled.
    expect(revoked).toEqual([]);
    vi.runAllTimers();
    expect(revoked).toEqual(['blob:download/1']);
  });
});

describe('saveText', () => {
  it('saves UTF-8 text, as plain text unless a type is given', async () => {
    saveText('note.txt', 'grüße');
    saveText('picture.svg', '<svg/>', 'image/svg+xml');
    expect(made.map((blob) => blob.type)).toEqual([
      'text/plain;charset=utf-8',
      'image/svg+xml;charset=utf-8',
    ]);
    expect(await made[0]?.text()).toBe('grüße');
    expect(clicks.map((click) => click.download)).toEqual(['note.txt', 'picture.svg']);
  });
});
