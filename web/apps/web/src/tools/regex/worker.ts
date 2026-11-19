import { serveWorker } from '@stuffcloud/tools';
import { isInput, runTask } from './match.ts';

serveWorker(runTask, { accepts: isInput });
