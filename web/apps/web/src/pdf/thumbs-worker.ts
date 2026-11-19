import { serveWorker } from '@stuffcloud/tools';
import { isThumbInput } from './thumb-input.ts';
import { renderThumbnails, thumbTransfer } from './thumbnails.ts';
import type { ThumbInput, ThumbOutput } from './types.ts';

serveWorker<ThumbInput, ThumbOutput>(
  (input, context) =>
    renderThumbnails(
      input,
      {
        createCanvas: (width, height) => new OffscreenCanvas(width, height),
        // pdf.js parses in a worker of its own (a file of the app, same origin, no CDN).
        createParserWorker: () =>
          new Worker(new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url), {
            type: 'module',
          }),
      },
      context,
    ),
  { accepts: isThumbInput, transfer: thumbTransfer },
);
