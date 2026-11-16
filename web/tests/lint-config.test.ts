import { resolve } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// The fixtures are excluded from `pnpm lint`; here they are linted on purpose with the
// real config (`ignore: false`) to prove the rules fire.
const eslint = new ESLint({ cwd: resolve(import.meta.dirname, '..'), ignore: false });

async function ruleIds(fixture: string): Promise<string[]> {
  const [result] = await eslint.lintFiles([`tests/fixtures/${fixture}`]);
  return (result?.messages ?? []).map((message) => message.ruleId ?? 'parse-error');
}

describe('lint configuration', () => {
  it('fails a deliberate `any`', async () => {
    expect(await ruleIds('explicit-any.ts')).toContain('@typescript-eslint/no-explicit-any');
  });

  it('fails a non-null assertion', async () => {
    expect(await ruleIds('non-null-assertion.ts')).toContain(
      '@typescript-eslint/no-non-null-assertion',
    );
  });

  it('fails a function without an explicit return type', async () => {
    expect(await ruleIds('missing-return-type.ts')).toContain(
      '@typescript-eslint/explicit-function-return-type',
    );
  });

  it('passes clean code, so the failures above are not a broken setup', async () => {
    expect(await ruleIds('clean.ts')).toEqual([]);
  });
});
