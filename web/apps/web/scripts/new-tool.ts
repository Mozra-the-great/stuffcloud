import { runScaffoldCli } from './scaffold.ts';

process.exitCode = await runScaffoldCli(process.argv.slice(2), {
  out: (message) => process.stdout.write(`${message}\n`),
  err: (message) => process.stderr.write(`${message}\n`),
});
