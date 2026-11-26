import type { Capability } from './capabilities.ts';
import type { ToolCategory } from './categories.ts';
import type { StickerName } from './stickers.ts';
import type { ToolId } from './tool-id.ts';

/** Where a tool does its work. v1 only has `client`; `server` is reserved (ADR 0004, ADR 0012). */
export type RunsIn = 'client' | 'server';

/**
 * Size budget in KiB (1024 bytes) of gzip-compressed files, documented per tool (SPEC 7).
 * `scriptKb` is the tool's own lazily loaded JavaScript and CSS (its page chunk and the chunks it
 * imports that the first page load does not fetch), `assetsKb` everything else it can download:
 * worker scripts and what they load (the pdf.js engine), WASM, models. The CI job `perf-budgets`
 * checks both against the production build (`pnpm check-budgets`, docs/PERFORMANCE.md).
 */
export interface ToolBudget {
  readonly scriptKb: number;
  readonly assetsKb: number;
}

/**
 * The privacy promise every tool makes, spelled out in the schema so it cannot be forgotten:
 * the files a visitor gives a tool stay in the browser. A manifest without this exact value does
 * not pass the schema, and a test fails when a tool source uses a network API.
 */
export const FILE_CONTENT_STAYS_IN_BROWSER = 'stays-in-browser';
export type FileContentPolicy = typeof FILE_CONTENT_STAYS_IN_BROWSER;

/**
 * What every tool module declares about itself. The registry builds navigation, search and
 * routing from these and from nothing else.
 *
 * `K` is the type of message keys (the app uses its `MessageKey`), `M` what `load()` resolves
 * to (the app uses its route module).
 */
export interface ToolManifest<K extends string = string, M = unknown> {
  /** Lowercase words joined by hyphens; the tool lives at `/tools/<id>`. */
  readonly id: ToolId;
  readonly category: ToolCategory;
  /** Message keys, always `tool.<id>.name`, `tool.<id>.description` and `tool.<id>.keywords`. */
  readonly nameKey: K;
  readonly descriptionKey: K;
  /** Extra search terms in the language of the catalogue, separated by spaces. */
  readonly keywordsKey: K;
  readonly sticker: StickerName;
  readonly runsIn: RunsIn;
  readonly fileContent: FileContentPolicy;
  /** Browser features the tool cannot work without. */
  readonly requires: readonly Capability[];
  readonly budget: ToolBudget;
  /** Dynamic import of the tool page: every tool is its own chunk. */
  readonly load: () => Promise<M>;
}

/** What an author writes: the same shape with a plain string as id (it is parsed). */
export type ToolManifestInput<K extends string = string, M = unknown> = Omit<
  ToolManifest<K, M>,
  'id'
> & { readonly id: string };

/** The three texts every tool has in every language. */
export type ToolTextField = 'name' | 'description' | 'keywords';

/** The message key of one text of tool `id`: `tool.<id>.<field>`. */
export function toolTextKey(id: string, field: ToolTextField): string {
  return `tool.${id}.${field}`;
}
