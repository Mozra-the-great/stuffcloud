import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { createRawSnippet, type Snippet } from 'svelte';

export const appRoot: string = resolve(import.meta.dirname, '..');
export const repoRoot: string = resolve(appRoot, '../../..');

export function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

/** Contents of every file with `extension` directly in the repo directory `dir`. */
export function readRepoFiles(dir: string, extension: string): string[] {
  return readdirSync(resolve(repoRoot, dir))
    .filter((name) => name.endsWith(extension))
    .map((name) => readRepoFile(`${dir}/${name}`));
}

/** A file of the installed design kit kern (ADR 0014), relative to its package root. */
export function readKernFile(path: string): string {
  const pkg = createRequire(import.meta.url).resolve('@mozra-the-great/kern/package.json');
  return readFileSync(resolve(dirname(pkg), path), 'utf8');
}

export function readAppFile(path: string): string {
  return readFileSync(resolve(appRoot, path), 'utf8');
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** A snippet that renders `<span>text</span>`, for components with a `children` prop. */
export function textSnippet(text: string): Snippet {
  return createRawSnippet(() => ({ render: () => `<span>${escapeHtml(text)}</span>` }));
}

/** Custom properties (`--name: value;`) of every given stylesheet, later files win. */
export function readCustomProperties(...paths: readonly string[]): Map<string, string> {
  const properties = new Map<string, string>();
  for (const path of paths) {
    const css = readAppFile(path).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      const [, name, value] = match;
      if (name !== undefined && value !== undefined) {
        properties.set(name, value.trim());
      }
    }
  }
  return properties;
}

/** A drag event with the `dataTransfer` jsdom does not provide. */
export function dataTransferInit(files: readonly File[]): {
  dataTransfer: { files: readonly File[]; dropEffect: string };
} {
  return { dataTransfer: { files, dropEffect: 'none' } };
}

/** A bubbling, cancelable drag-like event with extra properties (jsdom has no DragEvent). */
export function dragEvent(type: string, properties: Readonly<Record<string, unknown>> = {}): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const [name, value] of Object.entries(properties)) {
    Object.defineProperty(event, name, { value });
  }
  return event;
}

/** Field errors: kern's `Field` (Input, Select, Textarea). */
export const FIELD_ERROR = '.k-field .error';

/** Text of the first field error on the page, trimmed, or `null` when no field shows one. */
export function fieldErrorText(): string | null {
  return document.querySelector(FIELD_ERROR)?.textContent.trim() ?? null;
}
