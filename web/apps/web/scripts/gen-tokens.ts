import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { runTokensCli, SOURCE_PATH } from './tokens.ts';

const root = resolve(import.meta.dirname, '../../../..');
const sourceFile = resolve(root, SOURCE_PATH);
const generatedFile = resolve(import.meta.dirname, '../src/styles/tokens.css');

process.exitCode = runTokensCli(process.argv.slice(2), {
  readSource: () => readFileSync(sourceFile, 'utf8'),
  readGenerated: () => {
    try {
      return readFileSync(generatedFile, 'utf8');
    } catch {
      return undefined;
    }
  },
  writeGenerated: (content) => {
    mkdirSync(dirname(generatedFile), { recursive: true });
    writeFileSync(generatedFile, content);
  },
  out: (message) => process.stdout.write(`${message}\n`),
  err: (message) => process.stderr.write(`${message}\n`),
});
