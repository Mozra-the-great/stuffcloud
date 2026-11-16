/** What every benchmark variant gets: where to draw, what to draw and the browser services. */

export interface BenchArt {
  /** URL of one mascot SVG (a single frame). */
  readonly url: string;
  readonly cols: number;
  readonly rows: number;
}

/** Browser services, injected so the variants run under test with fakes. */
export interface BenchEnv {
  readonly document: Document;
  readonly devicePixelRatio: number;
  requestFrame(callback: (time: number) => void): number;
  cancelFrame(id: number): void;
  setInterval(callback: () => void, ms: number): number;
  clearInterval(id: number): void;
  fetchText(url: string): Promise<string>;
  loadImage(url: string): Promise<CanvasImageSource>;
  /** Makes a same-origin URL for generated SVG text; `revoke` releases it. */
  objectUrl(svg: string): { readonly url: string; readonly revoke: () => void };
}

export interface VariantContext {
  /** Container the variant appends its cells to. */
  readonly host: HTMLElement;
  readonly art: BenchArt;
  /** Integer scale: CSS pixels per art pixel. */
  readonly scale: number;
  /** How many mascots to draw (stress test for many on one page). */
  readonly count: number;
  readonly env: BenchEnv;
}

export interface MountedVariant {
  /** Stops all timers and loops and removes everything the variant added. */
  stop(): void;
}

export const VARIANT_NAMES = [
  'static',
  'css-transform',
  'css-sprite',
  'css-strip',
  'canvas-raf',
  'canvas-timer',
] as const;

export type VariantName = (typeof VARIANT_NAMES)[number];

export function isVariantName(value: string): value is VariantName {
  return (VARIANT_NAMES as readonly string[]).includes(value);
}
