import { serveWorker } from '@stuffcloud/tools';
import { isInput, runTask, transfer } from './task.ts';

serveWorker(runTask, { accepts: isInput, transfer });
