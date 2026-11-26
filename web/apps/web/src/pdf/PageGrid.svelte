<script lang="ts">
  import { tick } from 'svelte';
  import {
    allIds,
    columnsOf,
    idsBetween,
    isNavKey,
    moveStep,
    nextIndex,
    noIds,
    toggledAt,
  } from './grid-nav.ts';
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

  let list: HTMLDivElement | undefined = $state();
  /** Position that holds the Tab stop (roving tabindex); always inside the grid. */
  let current = $state(0);
  let anchor = $state(0);
  let dragFrom: number | undefined = $state();
  let dropAt: number | undefined = $state();

  const active = $derived(Math.min(current, Math.max(pages.length - 1, 0)));

  function items(): HTMLElement[] {
    return list === undefined
      ? []
      : Array.from(list.children).filter((el): el is HTMLElement => el instanceof HTMLElement);
  }

  /** Items in the first row: the number of columns the layout has right now. */
  function columns(): number {
    return columnsOf(items().map((item) => item.offsetTop));
  }

  async function focusAt(position: number): Promise<void> {
    current = position;
    await tick();
    items()[position]?.focus();
  }

  function toggle(position: number): void {
    anchor = position;
    onselect(toggledAt(selected, pages, position));
  }

  function selectRange(position: number): void {
    onselect(idsBetween(pages, anchor, position));
  }

  function onkeydown(event: KeyboardEvent): void {
    const position = active;
    if (event.altKey && onmove !== undefined) {
      const step = moveStep(event.key, columns());
      if (step !== undefined) {
        event.preventDefault();
        const target = position + step;
        if (target >= 0 && target < pages.length) {
          onmove(position, target);
          void focusAt(target);
        }
        return;
      }
    }
    if (event.altKey || event.metaKey) {
      return;
    }
    if (isNavKey(event.key)) {
      event.preventDefault();
      const target = nextIndex(event.key, position, pages.length, columns());
      if (event.shiftKey) {
        selectRange(target);
      } else {
        anchor = target;
      }
      void focusAt(target);
    } else if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) {
        selectRange(position);
      } else {
        toggle(position);
      }
    } else if ((event.key === 'a' || event.key === 'A') && event.ctrlKey) {
      event.preventDefault();
      onselect(allIds(pages));
    } else if (event.key === 'Escape' && selected.size > 0) {
      event.preventDefault();
      onselect(noIds());
    }
  }

  function onclick(event: MouseEvent, position: number): void {
    current = position;
    if (event.shiftKey) {
      selectRange(position);
    } else {
      toggle(position);
    }
  }

  function ondragstart(event: DragEvent, position: number): void {
    dragFrom = position;
    const transfer = event.dataTransfer;
    if (transfer) {
      transfer.effectAllowed = 'move';
      transfer.setData('text/plain', String(position));
    }
  }

  function ondragover(event: DragEvent, position: number): void {
    if (dragFrom === undefined) {
      return;
    }
    event.preventDefault();
    const transfer = event.dataTransfer;
    if (transfer) {
      transfer.dropEffect = 'move';
    }
    dropAt = position;
  }

  function ondrop(event: DragEvent, position: number): void {
    if (dragFrom === undefined) {
      return;
    }
    event.preventDefault();
    const from = dragFrom;
    dragFrom = undefined;
    dropAt = undefined;
    if (from !== position) {
      onmove?.(from, position);
      current = position;
    }
  }

  function ondragend(): void {
    dragFrom = undefined;
    dropAt = undefined;
  }
</script>

<!--
  The pages of a PDF as a listbox of pictures: one Tab stop, arrow keys between pages, Space
  selects, Shift extends, Ctrl+A selects all, Alt+arrow moves the page (when `onmove` is given).
  Drag and drop is an extra, never the only way. App-local: candidate for kern (#121, kern issue 68: a
  multi-select grid with keyboard reordering).
-->
{#if pages.length > 0}
  <div
    bind:this={list}
    class="grid"
    role="listbox"
    aria-label={label}
    aria-multiselectable="true"
    tabindex="-1"
    {onkeydown}
  >
    {#each pages as page, position (page.id)}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div
        class="page"
        class:selected={selected.has(page.id)}
        class:dragging={dragFrom === position}
        class:drop={dropAt === position && dragFrom !== position}
        role="option"
        aria-selected={selected.has(page.id)}
        aria-label={pageLabel(page, position + 1)}
        tabindex={position === active ? 0 : -1}
        onfocus={() => {
          current = position;
        }}
        draggable={onmove !== undefined}
        onclick={(event) => {
          onclick(event, position);
        }}
        ondragstart={(event) => {
          ondragstart(event, position);
        }}
        ondragover={(event) => {
          ondragover(event, position);
        }}
        ondrop={(event) => {
          ondrop(event, position);
        }}
        {ondragend}
      >
        <span class="picture"><PageThumb bitmap={store?.bitmap(page.id)} turn={page.turn} /></span>
        <span class="number" aria-hidden="true">{position + 1}</span>
        <span class="check" aria-hidden="true"></span>
      </div>
    {/each}
  </div>
{/if}

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: var(--k-space-4);
    outline: none;
  }

  .page {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--k-space-2);
    padding: var(--k-space-3);
    border: 1px solid var(--k-line-strong);
    cursor: pointer;
    user-select: none;
  }

  .picture {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 190px;
  }

  .number {
    font: 13px var(--k-font-mono);
    color: var(--k-fg-muted);
  }

  .check {
    position: absolute;
    top: 6px;
    right: 6px;
    width: 18px;
    height: 18px;
    border: 2px solid var(--k-fg);
    background: var(--k-bg);
  }

  .selected {
    border-color: var(--k-accent);
    background: var(--k-surface-selected);
  }

  .selected .check {
    background: var(--k-accent);
    border-color: var(--k-accent);
  }

  .selected .check::after {
    content: '';
    display: block;
    width: 5px;
    height: 9px;
    margin: 0 0 0 4px;
    border: solid var(--k-bg);
    border-width: 0 2px 2px 0;
    transform: rotate(45deg);
  }

  .dragging {
    opacity: 0.5;
  }

  .drop {
    border-style: dashed;
    border-color: var(--k-link);
  }

  @media (forced-colors: active) {
    .selected {
      border-color: Highlight;
      border-width: 3px;
    }

    .check {
      border-color: CanvasText;
    }

    .selected .check {
      background: Highlight;
    }
  }
</style>
