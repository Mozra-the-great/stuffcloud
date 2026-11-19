import { Router } from '../src/app/router/router.svelte.ts';
import { buildRoutes } from '../src/app/routes.ts';
import type { ToolCategory, ToolEntry } from '../src/app/tools.ts';

/** A tool whose page is `ToolPage.svelte` (an `<h1>` with the tool id), loaded lazily. */
export function makeTool(
  id: string,
  category: ToolCategory,
  en: string,
  de: string,
  load: ToolEntry['load'] = () => import('./ToolPage.svelte'),
): ToolEntry {
  return { id, category, name: { en, de }, load };
}

export const TOOLS: readonly ToolEntry[] = [
  makeTool('merge-pdf', 'pdf', 'Merge PDFs', 'PDFs zusammenfügen'),
  makeTool('split-pdf', 'pdf', 'Split PDF', 'PDF teilen'),
  makeTool('resize-image', 'image', 'Resize image', 'Bild verkleinern'),
];

export function createRouter(tools: readonly ToolEntry[]): Router {
  const { routes, notFound } = buildRoutes(tools);
  return new Router({ routes, notFound });
}

/** Lets pending promises and Svelte effects settle (route loading is asynchronous). */
export async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

/** The value, or a failure that names the problem: for lookups a test relies on. */
export function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error('expected a value, got nothing');
  }
  return value;
}
