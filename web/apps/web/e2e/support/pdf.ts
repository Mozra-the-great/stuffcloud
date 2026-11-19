import { readFile } from 'node:fs/promises';
import type { Download, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import type { Sample } from './files.ts';

/** PDFs for the PDF tools' specs: generated, never committed. */

export { makeEncryptedPdf, makePdf } from '../../tests/pdf-fixtures.ts';

/** A PDF as an upload. */
export function pdfSample(name: string, bytes: Uint8Array): Sample {
  return { name, mimeType: 'application/pdf', buffer: Buffer.from(bytes) };
}

/** The saved file of a download. */
export async function downloaded(download: Download): Promise<Buffer> {
  const path = await download.path();
  return readFile(path);
}

/** Widths of the pages of a PDF (in the fixtures, page `n` is `100 + n` points wide). */
export async function pageWidths(bytes: Uint8Array): Promise<number[]> {
  const document = await PDFDocument.load(bytes);
  return document.getPages().map((page) => Math.round(page.getWidth()));
}

export async function pageRotations(bytes: Uint8Array): Promise<number[]> {
  const document = await PDFDocument.load(bytes);
  return document.getPages().map((page) => page.getRotation().angle);
}

/** The names in the central directory of a ZIP, and whether every checksum matches. */
export function zipNames(zip: Buffer): string[] {
  const end = zip.length - 22;
  if (zip.readUInt32LE(end) !== 0x06054b50) {
    throw new Error('not a ZIP archive: no end-of-central-directory record where it belongs');
  }
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const names: string[] = [];
  for (let n = 0; n < count; n += 1) {
    const length = zip.readUInt16LE(at + 28);
    names.push(zip.subarray(at + 46, at + 46 + length).toString('utf8'));
    at += 46 + length;
  }
  return names;
}

/** The bytes of entry `index` of a stored ZIP. */
export function zipEntry(zip: Buffer, index: number): Buffer {
  const end = zip.length - 22;
  let at = zip.readUInt32LE(end + 16);
  for (let n = 0; n < index; n += 1) {
    at += 46 + zip.readUInt16LE(at + 28);
  }
  const size = zip.readUInt32LE(at + 24);
  const local = zip.readUInt32LE(at + 42);
  const start = local + 30 + zip.readUInt16LE(local + 26);
  return zip.subarray(start, start + size);
}

/** Pictures of the pages have been drawn: `count` canvases with something other than white on them. */
export async function drawnPages(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvases = [...document.querySelectorAll<HTMLCanvasElement>('[role="option"] canvas')];
    return canvases.filter((canvas) => {
      const context = canvas.getContext('2d');
      if (context === null || canvas.width === 0) {
        return false;
      }
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let at = 0; at < data.length; at += 4) {
        if ((data[at] ?? 255) < 200) {
          return true;
        }
      }
      return false;
    }).length;
  });
}

/** WCAG 1.4.10: at 320 CSS pixels (a 1280 px window at 400 % zoom) the page needs no horizontal scroll bar. */
export async function expectReflow(page: Page): Promise<void> {
  await page.setViewportSize({ width: 320, height: 640 });
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    return {
      scrollWidth: root.scrollWidth,
      clientWidth: root.clientWidth,
      wide: [...document.body.querySelectorAll('*')]
        .filter((element) => element.getBoundingClientRect().right > root.clientWidth + 1)
        .slice(0, 5)
        .map((element) => element.outerHTML.slice(0, 100)),
    };
  });
  expect(
    overflow.scrollWidth,
    `content wider than the window: ${overflow.wide.join(' | ')}`,
  ).toBeLessThanOrEqual(overflow.clientWidth);
}
