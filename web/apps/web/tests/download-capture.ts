import { vi } from 'vitest';

/** One file the page offered as a download: the name on the link and what the link pointed to. */
export interface SavedFile {
  readonly name: string;
  readonly blob: Blob;
}

export interface DownloadCapture {
  readonly files: SavedFile[];
  /** The saved files as UTF-8 text. */
  texts: () => Promise<{ name: string; text: string }[]>;
}

/**
 * Records every `<a download>` the page clicks (kern's `saveBlob` does exactly that) instead of
 * starting a download. `lookup` finds the blob behind an object URL the page made; without it this
 * installs its own `URL.createObjectURL` / `revokeObjectURL` stubs. Call it in `beforeEach`;
 * `vi.restoreAllMocks()` removes the click spy again.
 */
export function captureDownloads(lookup?: (url: string) => Blob | undefined): DownloadCapture {
  const files: SavedFile[] = [];
  let find = lookup;
  if (find === undefined) {
    const made = new Map<string, Blob>();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: (blob: Blob): string => {
        const url = `blob:download/${String(made.size)}`;
        made.set(url, blob);
        return url;
      },
    });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    find = (url) => made.get(url);
  }
  const lookupBlob = find;
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(
    this: HTMLAnchorElement,
  ) {
    const blob = lookupBlob(this.href);
    if (this.download !== '' && blob !== undefined) {
      files.push({ name: this.download, blob });
    }
  });
  return {
    files,
    texts: async () =>
      Promise.all(files.map(async (file) => ({ name: file.name, text: await file.blob.text() }))),
  };
}
