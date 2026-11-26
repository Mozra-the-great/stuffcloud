import { runBudgetCli } from './perf-budget.ts';

process.exitCode = await runBudgetCli(process.argv.slice(2), {
  out: (message) => process.stdout.write(`${message}\n`),
  err: (message) => process.stderr.write(`${message}\n`),
});
