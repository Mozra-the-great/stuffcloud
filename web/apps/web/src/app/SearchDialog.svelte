<script lang="ts">
  import { Modal } from '@mozra-the-great/kern';
  import { i18n, t } from '../i18n/index.ts';
  import Input from '../ui/Input.svelte';
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

  // kern's Modal reports only the closes of the visitor (Escape, close button, backdrop); the
  // closes of the app (a hit was opened) clear the query here, so the next search starts empty.
  function close(): void {
    open = false;
    query = '';
  }

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    const first = results[0];
    if (first !== undefined) {
      close();
      onnavigate(toolPath(first.id));
    }
  }
</script>

<!--
  kern's Modal renders its title row as <header> (and actions as <footer>); outside sectioning
  content these become banner/contentinfo landmarks next to the shell's own (kern#154). An unnamed
  <section> is role generic, adds no landmark and scopes them. Goes with the kern version that fixes it.
-->
<section>
  <Modal
    bind:open
    title={t('search.title')}
    closeLabel={t('search.close')}
    onclose={() => {
      query = '';
    }}
  >
    <div class="search">
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
              <a href={toolPath(tool.id)} onclick={close}>
                <span>{tool.name[i18n.locale]}</span>
                <span class="category">{t(CATEGORY_LABELS[tool.category])}</span>
              </a>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </Modal>
</section>

<style>
  /* kern's Modal puts the content in one block: the rows keep the old dialog's 20 px rhythm. */
  .search {
    display: flex;
    flex-direction: column;
    gap: var(--space-20);
  }

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
