<script lang="ts">
  import { detectCapabilities, missingCapabilities } from '@stuffcloud/tools';
  import type { Snippet } from 'svelte';
  import { i18n, t } from '../i18n/index.ts';
  import { getTools } from './context.ts';
  import Sticker from './Sticker.svelte';
  import { CAPABILITY_LABELS } from './tools.ts';
  import './pages/page.css';

  interface Props {
    /** The id of the tool, as in its manifest. */
    id: string;
    /** The tool itself (optional while it is being built); it is not rendered when the browser lacks something the tool needs. */
    children?: Snippet;
  }

  let { id, children }: Props = $props();

  const entry = $derived.by(() => {
    const found = getTools().find((tool) => tool.id === id);
    if (found === undefined) {
      throw new Error(`ToolFrame: there is no tool "${id}" in the registry`);
    }
    return found;
  });
  const missing = $derived(missingCapabilities(entry.requires, detectCapabilities(globalThis)));
  const missingText = $derived(
    new Intl.ListFormat(i18n.locale, { style: 'long', type: 'conjunction' }).format(
      missing.map((capability) => t(CAPABILITY_LABELS[capability])),
    ),
  );
</script>

<!--
  The frame every tool page uses: the one synchronous <h1> (the router moves focus to it), the
  description, the promise that files stay in the browser, and the notice when the browser
  cannot run the tool. App-specific (it reads the registry), so not a kern candidate.
-->
<section class="page tool">
  <header class="head">
    <Sticker name={entry.sticker} />
    <h1 class="page-title">{entry.name[i18n.locale]}</h1>
  </header>
  <p class="description">{entry.description[i18n.locale]}</p>
  <p class="note">{t('tool.localOnly')}</p>
  {#if missing.length > 0}
    <p class="unsupported">{t('tool.unsupported', { features: missingText })}</p>
  {:else}
    {@render children?.()}
  {/if}
</section>

<style>
  .tool {
    gap: var(--space-20);
  }

  .head {
    display: flex;
    align-items: center;
    gap: var(--space-20);
  }

  .description {
    margin: 0;
    max-width: 60ch;
  }

  .note {
    margin: 0;
    font: 13px var(--mono);
    color: var(--mut);
  }

  .unsupported {
    margin: 0;
    padding: var(--space-16);
    border: 1px solid var(--line);
  }
</style>
