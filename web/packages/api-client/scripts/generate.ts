/**
 * Generates `src/generated/schema.d.ts` from an OpenAPI document.
 *
 *   pnpm --filter @stuffcloud/api-client generate -- --input <openapi.json> [--check]
 *
 * With `--check` nothing is written; the script fails when the committed file differs from
 * what would be generated. CI uses this to reject a stale client once `app` exists (A-01).
 */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateSchema, parseArguments } from './generate-lib.ts';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = resolve(packageRoot, 'src/generated/schema.d.ts');

async function main(argv: readonly string[]): Promise<void> {
  const parsed = parseArguments(argv);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  const { input, check } = parsed.value;
  await access(input).catch(() => {
    throw new Error(`OpenAPI document not found: ${input}`);
  });
  const schema = await generateSchema(pathToFileURL(input));
  if (check) {
    const current = await readFile(outputPath, 'utf8').catch(() => '');
    if (current !== schema) {
      throw new Error('src/generated/schema.d.ts is stale: run `pnpm generate` and commit it');
    }
    return;
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, schema, 'utf8');
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
