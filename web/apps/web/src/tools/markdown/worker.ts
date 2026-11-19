import { serveWorker } from '@stuffcloud/tools';
import { isInput, runTask } from './parse.ts';

serveWorker(runTask, { accepts: isInput });
