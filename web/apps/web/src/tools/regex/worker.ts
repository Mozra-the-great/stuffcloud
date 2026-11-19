import { serveWorker } from '@stuffcloud/tools';
import { runTask } from './task.ts';

serveWorker(runTask);
