<script lang="ts">
  import './styles/index.css';
  import Shell from './app/Shell.svelte';
  import { buildRoutes } from './app/routes.ts';
  import { Router } from './app/router/router.svelte.ts';
  import { TOOL_ENTRIES } from './app/tool-entries.ts';

  const { routes, notFound } = buildRoutes(TOOL_ENTRIES);
  const router = new Router({ routes, notFound });
</script>

<Shell {router} tools={TOOL_ENTRIES} />
