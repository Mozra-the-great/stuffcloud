import { defineTool as define, type ToolManifest, type ToolManifestInput } from '@stuffcloud/tools';
import type { RouteModule } from '../app/router/router.svelte.ts';
import type { MessageKey } from '../i18n/messages/en.ts';

/**
 * Declares a tool of this app: `src/tools/<id>/manifest.ts` exports the result as its default
 * export. The message keys must exist in the catalogues (a typo does not compile) and `load`
 * must resolve to the page of the tool. The schema (see `@stuffcloud/tools`) is checked when the
 * file loads, which is also what stops the build.
 */
export function defineTool(
  input: ToolManifestInput<MessageKey, RouteModule>,
): ToolManifest<MessageKey, RouteModule> {
  return define(input);
}
