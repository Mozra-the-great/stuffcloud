import { serveWorker } from '@stuffcloud/tools';
import { isPdfInput, runPdfTask, transferOf } from './task.ts';
import type { PdfInput, PdfOutput } from './types.ts';

serveWorker<PdfInput, PdfOutput>(runPdfTask, { accepts: isPdfInput, transfer: transferOf });
