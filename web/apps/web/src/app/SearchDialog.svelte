<script lang="ts">
  import { Input } from '@mozra-the-great/kern';
  import { i18n, t } from '../i18n/index.ts';
  import Dialog from '../ui/Dialog.svelte';
  import { CATEGORY_LABELS, searchTools, toolPath, type ToolEntry } from './tools.ts';

  interface Props {
    open?: boolean;
    tools: readonly ToolEntry[];
    /** Opens a result (the first one when the visitor presses Enter). */
    onnavigate: (href: string) => void;
  }

  let { open = $bindable(false), tools, onnavigate }: Props = $props();

  let query = $state('');
  const results = $derived(searchTools(tools, query, i18n.locale));
  const searching = $derived(query.trim() !== '');
  // Heard through the live region while typing: the list itself is not announced.
  const status = $derived(
    !searching
      ? ''
      : results.length === 0
        ? t('search.none')
        : t('search.count', { count: results.length }),
  );

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    const first = results[0];
    if (first !== undefined) {
      open = false;
      onnavigate(toolPath(first.id));
    }
  }
</script>

<Dialog
  bind:open
  title={t('search.title')}
  closeLabel={t('search.close')}
  onclose={() => {
    query = '';
  }}
>
  <form role="search" onsubmit={submit}>
    <Input
      label={t('search.label')}
      type="search"
      autocomplete="off"
      autofocus
      bind:value={query}
    />
  </form>
  <p class="status" role="status">{status}</p>
  {#if results.length > 0}
    <ul class="results" aria-label={t('search.results')}>
      {#each results as tool (tool.id)}
        <li>
          <a
            href={toolPath(tool.id)}
            onclick={() => {
              open = false;
            }}
          >
            <span>{tool.name[i18n.locale]}</span>
            <span class="category">{t(CATEGORY_LABELS[tool.category])}</span>
          </a>
        </li>
      {/each}
    </ul>
  {/if}
</Dialog>

<style>
  .status {
    margin: 0;
    font: 13px var(--mono);
    color: var(--mut);
    min-height: 1.5em;
  }

  .results {
    margin: 0;
    padding: 0;
    list-style: none;
    border-top: 1px solid var(--line);
  }

  .results a {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-16);
    min-height: var(--target-min);
    padding: var(--space-8) var(--space-8);
    border-bottom: 1px solid var(--line);
  }

  .results a:hover {
    background: var(--bg-raised);
  }

  .category {
    font: 13px var(--mono);
    color: var(--mut);
  }
</style>
