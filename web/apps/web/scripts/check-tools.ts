import { runCheckCli } from './tool-check.ts';

process.exitCode = await runCheckCli(process.argv.slice(2), {
  out: (message) => process.stdout.write(`${message}\n`),
  err: (message) => process.stderr.write(`${message}\n`),
});
