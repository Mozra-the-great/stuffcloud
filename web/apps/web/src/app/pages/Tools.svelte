<script lang="ts">
  import { Mascot, TabLinks, Tile, TileGrid, type TabLinkItem } from '@mozra-the-great/kern';
  import { i18n, t } from '../../i18n/index.ts';
  import { getTools } from '../context.ts';
  import type { RouteProps } from '../router/router.svelte.ts';
  import Sticker from '../Sticker.svelte';
  import { TOOLS_PATH } from '../routes.ts';
  import {
    CATEGORY_LABELS,
    isToolCategory,
    toolPath,
    toolsInCategory,
    usedCategories,
  } from '../tools.ts';
  import './page.css';
  import { MASCOT_URLS } from '../mascots.ts';

  let { query }: RouteProps = $props();

  const tools = getTools();
  // An unknown `?category=` shows everything instead of an error.
  const requested = $derived(query.get('category') ?? '');
  const category = $derived(isToolCategory(requested) ? requested : undefined);
  const visible = $derived(toolsInCategory(tools, category));
  const links = $derived<readonly TabLinkItem[]>([
    { href: TOOLS_PATH, label: t('tools.all'), current: category === undefined },
    ...usedCategories(tools).map((name) => ({
      href: `${TOOLS_PATH}?category=${name}`,
      label: t(CATEGORY_LABELS[name]),
      current: category === name,
    })),
  ]);
</script>

<section class="page tools">
  <h1 class="page-title">{t('tools.title')}</h1>
  {#if tools.length > 0}
    <TabLinks {links} label={t('tools.categories')} />
  {/if}
  {#if visible.length === 0}
    <div class="empty">
      <Mascot name="stuffy" src={MASCOT_URLS.stuffy} scale={8} compactScale={6} />
      <p class="note">{t('tools.empty')}</p>
    </div>
  {:else}
    <p class="note">{t('tools.count', { count: visible.length })}</p>
    <TileGrid class="tiles">
      {#each visible as tool (tool.id)}
        <Tile href={toolPath(tool.id)}>
          <Sticker name={tool.sticker} />
          <span class="name">{tool.name[i18n.locale]}</span>
          <span class="note">{t(CATEGORY_LABELS[tool.category])}</span>
        </Tile>
      {/each}
    </TileGrid>
  {/if}
</section>

<style>
  .tools {
    gap: var(--k-space-5);
  }

  .empty {
    display: flex;
    align-items: center;
    gap: var(--k-space-5);
    padding: var(--k-space-6) 0;
  }

  .note {
    margin: 0;
    font: 13px var(--k-font-mono);
    color: var(--k-fg-muted);
  }

  /* kern's grid has inline-size containment, so `.page > div { align-self: flex-start }` (page.css)
     would shrink it to nothing: it fills the page. */
  .tools :global(.tiles) {
    align-self: stretch;
  }

  .name {
    font-size: 22px;
    font-weight: 500;
    overflow-wrap: anywhere;
  }
</style>
