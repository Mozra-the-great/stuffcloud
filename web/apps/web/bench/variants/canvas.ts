import { BOB_OFFSET_PX, BOB_PERIOD_MS } from '../../src/ui/motion.ts';
import type { MountedVariant, VariantContext } from './types.ts';

/** 0 is the rest pose, 1 the raised one. */
type Pose = 0 | 1;

export type CanvasDriver = 'raf' | 'timer';

const HALF_PERIOD_MS = BOB_PERIOD_MS / 2;

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d');
  if (context === null) {
    throw new Error('2D canvas is not available');
  }
  return context;
}

/**
 * The best case of the canvas approach: both poses are rasterised once into off-screen canvases
 * (integer scale, `imageSmoothingEnabled` off, backing store in device pixels), and a frame only
 * copies one of them when the pose changes. `raf` drives that from one `requestAnimationFrame`
 * loop for all mascots, `timer` from one `setInterval` per half period.
 */
export async function mountCanvas(
  context: VariantContext,
  driver: CanvasDriver,
): Promise<MountedVariant> {
  const { host, art, scale, count, env } = context;
  const image = await env.loadImage(art.url);
  const ratio = env.devicePixelRatio;
  const width = art.cols * scale;
  const height = art.rows * scale + BOB_OFFSET_PX;

  const makePose = (top: number): HTMLCanvasElement => {
    const pose = env.document.createElement('canvas');
    pose.width = Math.round(width * ratio);
    pose.height = Math.round(height * ratio);
    const drawing = context2d(pose);
    drawing.imageSmoothingEnabled = false;
    drawing.drawImage(
      image,
      0,
      Math.round(top * ratio),
      Math.round(width * ratio),
      Math.round(art.rows * scale * ratio),
    );
    return pose;
  };
  const poses = [makePose(BOB_OFFSET_PX), makePose(0)] as const;

  const cells: HTMLElement[] = [];
  const targets: CanvasRenderingContext2D[] = [];
  for (let index = 0; index < count; index += 1) {
    const cell = env.document.createElement('span');
    cell.className = 'bench-cell';
    const canvas = env.document.createElement('canvas');
    canvas.className = 'bench-canvas';
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.style.width = `${String(width)}px`;
    canvas.style.height = `${String(height)}px`;
    cell.append(canvas);
    host.append(cell);
    cells.push(cell);
    targets.push(context2d(canvas));
  }

  let shown: Pose | null = null;
  const show = (pose: Pose): void => {
    if (pose === shown) {
      return;
    }
    shown = pose;
    const source = poses[pose];
    for (const target of targets) {
      target.clearRect(0, 0, source.width, source.height);
      target.drawImage(source, 0, 0);
    }
  };

  show(0);
  let stopLoop: () => void;
  if (driver === 'raf') {
    let frame = env.requestFrame(function tick(time: number): void {
      show(Math.floor(time / HALF_PERIOD_MS) % 2 === 0 ? 0 : 1);
      frame = env.requestFrame(tick);
    });
    stopLoop = (): void => {
      env.cancelFrame(frame);
    };
  } else {
    let pose: Pose = 0;
    const timer = env.setInterval(() => {
      pose = pose === 0 ? 1 : 0;
      show(pose);
    }, HALF_PERIOD_MS);
    stopLoop = (): void => {
      env.clearInterval(timer);
    };
  }

  return {
    stop: (): void => {
      stopLoop();
      for (const cell of cells) {
        cell.remove();
      }
    },
  };
}
