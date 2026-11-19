import type { ToolManifestInput } from '../src/index.ts';

/** A manifest that passes the schema; tests change one field at a time. */
export function validInput(id = 'pdf-merge'): ToolManifestInput {
  return {
    id,
    category: 'pdf',
    nameKey: `tool.${id}.name`,
    descriptionKey: `tool.${id}.description`,
    keywordsKey: `tool.${id}.keywords`,
    sticker: 'pdf-merge',
    runsIn: 'client',
    fileContent: 'stays-in-browser',
    requires: ['worker', 'wasm'],
    budget: { scriptKb: 120, assetsKb: 0 },
    load: () => Promise.resolve({}),
  };
}

/** The same manifest as a plain record, so a test can set a field to a wrong type. */
export function mutate(
  change: Readonly<Record<string, unknown>>,
  id = 'pdf-merge',
): Record<string, unknown> {
  return { ...validInput(id), ...change };
}

/** Deterministic pseudo-random numbers (mulberry32), so a failing property run can be repeated. */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
