<script lang="ts">
  import { SelectGrid } from '@mozra-the-great/kern';
  import { t } from '../i18n/index.ts';
  import PageThumb from './PageThumb.svelte';
  import type { ThumbnailStore } from './thumbs.svelte.ts';

  interface GridPage {
    /** Zero-based page number in the file. */
    readonly id: number;
    /** Clockwise degrees the visitor turned the page by. */
    readonly turn: number;
  }

  interface Props {
    pages: readonly GridPage[];
    /** Ids of the selected pages. */
    selected: ReadonlySet<number>;
    store: ThumbnailStore | undefined;
    /** Name of the whole grid (the listbox). */
    label: string;
    /** Name of one page for assistive technology, for example "Position 3: page 7, turned 90 degrees". */
    pageLabel: (page: GridPage, position: number) => string;
    onselect: (selected: Set<number>) => void;
    /** Moves the page at one position to another (Alt + arrow keys, drag and drop); leave out for a grid that only selects. */
    onmove?: (from: number, to: number) => void;
  }

  let { pages, selected, store, label, pageLabel, onselect, onmove }: Props = $props();

  /** kern wants the selected keys in the order of the items. */
  const chosen = $derived(pages.filter((page) => selected.has(page.id)).map((page) => page.id));
</script>

<!--
  The pages of a PDF as kern's SelectGrid: a multi-select listbox of pictures with one Tab stop, arrow
  keys between pages, Space selects, Shift extends, Ctrl+A selects all, Alt+arrow moves the page (with
  `onmove`); drag and drop is an extra. This wrapper maps page ids and a Set to kern's keys, draws the
  thumbnail (PageThumb, on a canvas) with the page number, and passes the texts from the catalogue.
  kern's grid renders nothing for no pages and survives its last page going away (kern#175, 0.14.0).
-->
<SelectGrid
  class="page-grid"
  items={pages}
  key={(page: GridPage) => page.id}
  itemLabel={(page: GridPage, index: number) => pageLabel(page, index + 1)}
  selected={chosen}
  {label}
  reorderable={onmove !== undefined}
  reorderHint={t('pdf.pages.reorderHint')}
  onchange={(keys) => {
    onselect(new Set(keys.map(Number)));
  }}
  {onmove}
>
  {#snippet item(page: GridPage, index: number)}
    <span class="cell">
      <span class="picture"><PageThumb bitmap={store?.bitmap(page.id)} turn={page.turn} /></span>
      <span class="number" aria-hidden="true">{index + 1}</span>
    </span>
  {/snippet}
</SelectGrid>

<style>
  .cell {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-8);
    width: 100%;
    height: 100%;
  }

  .picture {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1 1 0;
    min-height: 0;
    width: 100%;
  }

  .number {
    font: 13px var(--mono);
    color: var(--mut);
  }

  /* The pages are portrait: a frame of 150 x 215 px at the smallest column width, as before. */
  :global(.page-grid) {
    --k-select-grid-min: 150px;
    --k-select-grid-ratio: 150 / 215;
  }
</style>
