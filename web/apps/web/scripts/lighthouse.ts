import { runLighthouseGate } from './lighthouse-run.ts';

process.exitCode = await runLighthouseGate(process.argv.slice(2));
