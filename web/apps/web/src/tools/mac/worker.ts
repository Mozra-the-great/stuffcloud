import { serveWorker } from '@stuffcloud/tools';
import { isInput, runTask } from './task.ts';

serveWorker(runTask, { accepts: isInput });
