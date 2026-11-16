import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runBench, startBench, type RunEnv, type RunOptions } from '../bench/runner.ts';
import { mountCanvas } from '../bench/variants/canvas.ts';
import { mountVariant } from '../bench/variants/index.ts';
import {
  isVariantName,
  VARIANT_NAMES,
  type BenchArt,
  type BenchEnv,
  type VariantContext,
} from '../bench/variants/types.ts';

const ART: BenchArt = { url: '/axo.svg', cols: 16, rows: 11 };
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 11"><path d="M0 0h1v1h-1z"/></svg>';

interface Drawing {
  readonly canvas: HTMLCanvasElement;
  readonly calls: string[];
  smoothing: boolean | undefined;
}

class FakeEnv implements BenchEnv {
  readonly document: Document = document;
  readonly devicePixelRatio: number;
  readonly drawings = drawings;
  readonly frames = new Map<number, (time: number) => void>();
  readonly intervals = new Map<number, () => void>();
  readonly revoked: string[] = [];
  readonly fetched: string[] = [];
  private counter = 0;

  constructor(devicePixelRatio = 1) {
    this.devicePixelRatio = devicePixelRatio;
  }

  requestFrame(callback: (time: number) => void): number {
    this.counter += 1;
    this.frames.set(this.counter, callback);
    return this.counter;
  }

  cancelFrame(id: number): void {
    this.frames.delete(id);
  }

  setInterval(callback: () => void): number {
    this.counter += 1;
    this.intervals.set(this.counter, callback);
    return this.counter;
  }

  clearInterval(id: number): void {
    this.intervals.delete(id);
  }

  async fetchText(url: string): Promise<string> {
    this.fetched.push(url);
    return Promise.resolve(SVG);
  }

  async loadImage(): Promise<CanvasImageSource> {
    return Promise.resolve(new Image());
  }

  objectUrl(svg: string): { url: string; revoke: () => void } {
    const url = `blob:test/${String(svg.length)}`;
    return { url, revoke: (): void => void this.revoked.push(url) };
  }

  /** Runs the one pending animation frame callback at `time`. */
  tick(time: number): void {
    const [id, callback] = [...this.frames.entries()][0] ?? [];
    if (id === undefined || callback === undefined) {
      throw new Error('no frame requested');
    }
    this.frames.delete(id);
    callback(time);
  }

  canvases(): HTMLCanvasElement[] {
    return [...document.querySelectorAll<HTMLCanvasElement>('.bench-canvas')];
  }

  callsOf(canvas: HTMLCanvasElement): string[] {
    return this.drawings.get(canvas)?.calls ?? [];
  }
}

const drawings = new Map<HTMLCanvasElement, Drawing>();
const poseIndex = new WeakMap<HTMLCanvasElement, number>();
let poseCounter = 0;

function poseOf(canvas: HTMLCanvasElement): number {
  return poseIndex.get(canvas) ?? -1;
}

/**
 * jsdom has no 2D context. This stand-in records every call; the off-screen pose canvases (the
 * ones without a class) are numbered in the order their context is first requested.
 */
function installCanvasMock(): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    let drawing = drawings.get(this);
    if (drawing === undefined) {
      drawing = { canvas: this, calls: [], smoothing: undefined };
      drawings.set(this, drawing);
      if (this.className === '') {
        poseIndex.set(this, poseCounter);
        poseCounter += 1;
      }
    }
    const target = drawing;
    return {
      clearRect: (x: number, y: number, w: number, h: number): void => {
        target.calls.push(`clear ${String(x)} ${String(y)} ${String(w)} ${String(h)}`);
      },
      drawImage: (source: unknown, ...rest: number[]): void => {
        const label = source instanceof HTMLCanvasElement ? `pose${String(poseOf(source))}` : 'art';
        target.calls.push(`draw ${label} ${rest.join(' ')}`);
      },
      set imageSmoothingEnabled(value: boolean) {
        target.smoothing = value;
      },
    } as unknown as CanvasRenderingContext2D;
  });
}

function context(env: BenchEnv, count = 3, scale = 4): VariantContext {
  const host = document.createElement('div');
  document.body.append(host);
  return { host, art: ART, scale, count, env };
}

beforeEach(() => {
  installCanvasMock();
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
  drawings.clear();
  poseCounter = 0;
});

describe('variant names', () => {
  it('knows exactly the five variants', () => {
    expect(VARIANT_NAMES).toEqual([
      'static',
      'css-transform',
      'css-sprite',
      'css-strip',
      'canvas-raf',
      'canvas-timer',
    ]);
    for (const name of VARIANT_NAMES) {
      expect(isVariantName(name)).toBe(true);
    }
    expect(isVariantName('canvas')).toBe(false);
    expect(isVariantName('')).toBe(false);
  });
});

describe('mountVariant', () => {
  it('starts every variant by name', async () => {
    for (const name of VARIANT_NAMES) {
      const env = new FakeEnv();
      const ctx = context(env, 1, 2);
      const variant = await mountVariant(name, ctx);
      expect(ctx.host.children, name).toHaveLength(1);
      variant.stop();
      expect(ctx.host.children, name).toHaveLength(0);
      drawings.clear();
      poseCounter = 0;
    }
  });
});

describe('image variants', () => {
  it('static draws still images at the integer size with no animation class', async () => {
    const env = new FakeEnv();
    const ctx = context(env, 3, 4);
    const variant = await mountVariant('static', ctx);
    const images = ctx.host.querySelectorAll('img');
    expect(images).toHaveLength(3);
    for (const image of images) {
      expect(image.getAttribute('src')).toBe('/axo.svg');
      expect(image.width).toBe(64);
      expect(image.height).toBe(44);
      expect(image.className).toBe('bench-art');
      expect(image.alt).toBe('');
    }
    variant.stop();
    expect(ctx.host.children).toHaveLength(0);
  });

  it('css-transform adds the bob class to every image', async () => {
    const env = new FakeEnv();
    const ctx = context(env, 2, 2);
    const variant = await mountVariant('css-transform', ctx);
    const images = [...ctx.host.querySelectorAll('img')];
    expect(images.map((image) => image.className)).toEqual([
      'bench-art bench-bob',
      'bench-art bench-bob',
    ]);
    variant.stop();
    expect(ctx.host.children).toHaveLength(0);
  });
});

describe('css-sprite variant', () => {
  it('builds the sheet from the svg, sizes every sprite to one frame and revokes on stop', async () => {
    const env = new FakeEnv();
    const ctx = context(env, 2, 4);
    const variant = await mountVariant('css-sprite', ctx);
    expect(env.fetched).toEqual(['/axo.svg']);
    const sprites = [...ctx.host.querySelectorAll<HTMLElement>('.bench-sprite')];
    expect(sprites).toHaveLength(2);
    for (const sprite of sprites) {
      expect(sprite.style.width).toBe('64px');
      expect(sprite.style.height).toBe('48px');
      expect(sprite.style.backgroundSize).toBe('64px 96px');
      expect(sprite.style.backgroundImage).toContain('blob:test/');
      expect(sprite.style.getPropertyValue('--frame-h')).toBe('48px');
    }
    expect(env.revoked).toHaveLength(0);
    variant.stop();
    expect(ctx.host.children).toHaveLength(0);
    expect(env.revoked).toHaveLength(1);
  });

  it('css-strip animates a clipped image of the whole sheet, not a background', async () => {
    const env = new FakeEnv();
    const ctx = context(env, 2, 4);
    const variant = await mountVariant('css-strip', ctx);
    const clips = [...ctx.host.querySelectorAll<HTMLElement>('.bench-clip')];
    expect(clips).toHaveLength(2);
    for (const clip of clips) {
      expect(clip.style.width).toBe('64px');
      expect(clip.style.height).toBe('48px');
      const strip = clip.querySelector('img');
      expect(strip?.className).toBe('bench-strip');
      expect(strip?.getAttribute('src')).toContain('blob:test/');
      expect(strip?.width).toBe(64);
      expect(strip?.height).toBe(96);
      expect(strip?.style.getPropertyValue('--frame-h')).toBe('48px');
    }
    expect(ctx.host.querySelector('.bench-sprite')).toBeNull();
    variant.stop();
    expect(ctx.host.children).toHaveLength(0);
    expect(env.revoked).toHaveLength(1);
  });

  it('fails clearly when the art is not an svg document', async () => {
    const env = new FakeEnv();
    vi.spyOn(env, 'fetchText').mockResolvedValue('nope');
    await expect(mountVariant('css-sprite', context(env))).rejects.toThrow('not an SVG document');
  });
});

describe('canvas variants', () => {
  it('rasterises both poses once, smoothing off, at the device pixel ratio', async () => {
    const env = new FakeEnv(2);
    const ctx = context(env, 2, 4);
    const variant = await mountVariant('canvas-timer', ctx);
    const canvases = env.canvases();
    expect(canvases).toHaveLength(2);
    for (const canvas of canvases) {
      // css size: 64 x (44 + 4 px headroom); backing store at 2x
      expect(canvas.style.width).toBe('64px');
      expect(canvas.style.height).toBe('48px');
      expect(canvas.width).toBe(128);
      expect(canvas.height).toBe(96);
    }
    const poses = [...env.drawings.values()].filter(
      (d) => d.calls[0]?.startsWith('draw art') === true,
    );
    expect(poses).toHaveLength(2);
    // rest pose sits 4 css px (8 device px) lower than the raised pose
    expect(poses[0]?.calls).toEqual(['draw art 0 8 128 88']);
    expect(poses[1]?.calls).toEqual(['draw art 0 0 128 88']);
    expect(poses.every((pose) => pose.smoothing === false)).toBe(true);
    variant.stop();
    expect(ctx.host.children).toHaveLength(0);
  });

  it('timer variant swaps the pose on every interval tick and clears the interval on stop', async () => {
    const env = new FakeEnv();
    const ctx = context(env, 2, 4);
    const variant = await mountCanvas(ctx, 'timer');
    const [canvas] = env.canvases();
    if (canvas === undefined) {
      throw new Error('no canvas');
    }
    expect(env.frames.size).toBe(0);
    expect(env.intervals.size).toBe(1);
    expect(env.callsOf(canvas)).toEqual(['clear 0 0 64 48', 'draw pose0 0 0']);
    const [tick] = [...env.intervals.values()];
    tick?.();
    tick?.();
    expect(env.callsOf(canvas).slice(2)).toEqual([
      'clear 0 0 64 48',
      'draw pose1 0 0',
      'clear 0 0 64 48',
      'draw pose0 0 0',
    ]);
    variant.stop();
    expect(env.intervals.size).toBe(0);
  });

  it('raf variant redraws only when the pose changes and cancels its loop on stop', async () => {
    const env = new FakeEnv();
    const ctx = context(env, 1, 4);
    const variant = await mountCanvas(ctx, 'raf');
    const [canvas] = env.canvases();
    if (canvas === undefined) {
      throw new Error('no canvas');
    }
    expect(env.intervals.size).toBe(0);
    expect(env.frames.size).toBe(1);
    const initial = env.callsOf(canvas).length;
    env.tick(100); // still the first half period
    env.tick(599);
    expect(env.callsOf(canvas)).toHaveLength(initial);
    env.tick(600); // second half period: raised pose
    expect(env.callsOf(canvas).slice(initial)).toEqual(['clear 0 0 64 48', 'draw pose1 0 0']);
    env.tick(1100);
    expect(env.callsOf(canvas)).toHaveLength(initial + 2);
    env.tick(1200); // back to the rest pose
    expect(env.callsOf(canvas).slice(initial + 2)).toEqual(['clear 0 0 64 48', 'draw pose0 0 0']);
    expect(env.frames.size).toBe(1);
    variant.stop();
    expect(env.frames.size).toBe(0);
    expect(ctx.host.children).toHaveLength(0);
  });

  it('fails clearly when there is no 2D canvas', async () => {
    const env = new FakeEnv();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    await expect(mountCanvas(context(env), 'raf')).rejects.toThrow('2D canvas is not available');
  });
});

describe('benchmark runner', () => {
  class RunFakeEnv extends FakeEnv implements RunEnv {
    slept: number[] = [];
    shifts: { value: number; hadRecentInput: boolean }[] = [];
    tasks: number[] = [];
    running = 1;
    stoppedObservers = 0;

    async sleep(ms: number): Promise<void> {
      this.slept.push(ms);
      for (const time of [0, 16, 32, 64]) {
        if (this.frames.size > 0) {
          this.tick(time);
        }
      }
      return Promise.resolve();
    }

    observeLayoutShifts(): () => readonly { value: number; hadRecentInput: boolean }[] {
      return () => {
        this.stoppedObservers += 1;
        return this.shifts;
      };
    }

    observeLongTasks(): () => readonly number[] {
      return () => {
        this.stoppedObservers += 1;
        return this.tasks;
      };
    }

    runningAnimations(): number {
      return this.running;
    }
  }

  const options = (sample: boolean): RunOptions => ({
    variant: 'css-transform',
    count: 2,
    scale: 4,
    durationMs: 1234,
    sample,
  });

  it('samples frames, reports shifts, long tasks and running animations, then cleans up', async () => {
    const env = new RunFakeEnv();
    env.shifts = [
      { value: 0.2, hadRecentInput: false },
      { value: 0.9, hadRecentInput: true },
    ];
    env.tasks = [60, 90];
    const host = document.createElement('div');
    document.body.append(host);
    const result = await runBench(options(true), ART, host, env);
    expect(env.slept).toEqual([1234]);
    expect(result.options).toEqual(options(true));
    expect(result.frames?.frames).toBe(3);
    expect(result.frames?.maxMs).toBe(32);
    expect(result.layoutShift).toBeCloseTo(0.2, 10);
    expect(result.longTasks).toEqual({ count: 2, totalMs: 150 });
    expect(result.runningAnimations).toBe(1);
    expect(env.stoppedObservers).toBe(2);
    expect(env.frames.size).toBe(0);
    expect(host.children).toHaveLength(0);
  });

  it('leaves the page idle (no frame sampler, no statistics) when sampling is off', async () => {
    const env = new RunFakeEnv();
    const host = document.createElement('div');
    document.body.append(host);
    const result = await runBench(options(false), ART, host, env);
    expect(result.frames).toBeNull();
    expect(env.frames.size).toBe(0);
    expect(result.longTasks).toEqual({ count: 0, totalMs: 0 });
    expect(result.layoutShift).toBe(0);
  });

  it('mounts before it reports, so mounting stays out of the measured span', async () => {
    const env = new RunFakeEnv();
    const host = document.createElement('div');
    document.body.append(host);
    const running = await startBench(options(false), ART, host, env);
    expect(host.querySelectorAll('img')).toHaveLength(2);
    expect(env.slept).toEqual([]);
    await running.finish();
    expect(env.slept).toEqual([1234]);
    expect(host.querySelectorAll('img')).toHaveLength(0);
  });
});
