import type { RouteDefinition } from './router/router.svelte.ts';
import { toolPath, type ToolEntry } from './tools.ts';

export interface RouteTable {
  readonly routes: readonly RouteDefinition[];
  readonly notFound: RouteDefinition;
}

export const HOME_PATH = '/';
export const TOOLS_PATH = '/tools';

/**
 * Every page is a dynamic import (its own chunk). Each tool gets its own route
 * (`/tools/<id>`), so a deep link loads the shell and that one tool only.
 */
export function buildRoutes(tools: readonly ToolEntry[]): RouteTable {
  return {
    routes: [
      { id: 'home', path: HOME_PATH, load: () => import('./pages/Home.svelte') },
      { id: 'tools', path: TOOLS_PATH, load: () => import('./pages/Tools.svelte') },
      ...tools.map((tool): RouteDefinition => ({
        id: `tool:${tool.id}`,
        path: toolPath(tool.id),
        load: tool.load,
      })),
    ],
    notFound: {
      id: 'not-found',
      path: '*',
      load: () => import('./pages/NotFound.svelte'),
    },
  };
}
