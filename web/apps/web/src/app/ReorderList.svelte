<script lang="ts" generics="T">
  import { Button } from '@mozra-the-great/kern';
  import { tick, type Snippet } from 'svelte';

  interface Props {
    items: readonly T[];
    /** A key that stays with the item when it moves. */
    keyOf: (item: T) => string | number;
    /** Name of the list. */
    label: string;
    /** Visible text and accessible names of the buttons of one item. */
    texts: {
      up: string;
      down: string;
      remove: string;
      upLabel: (item: T) => string;
      downLabel: (item: T) => string;
      removeLabel: (item: T) => string;
    };
    /** Moves the item at `from` so that it ends up at `to`. */
    onmove: (from: number, to: number) => void;
    onremove: (index: number) => void;
    /** The content of one item (name, size, ...). */
    row: Snippet<[item: T, index: number]>;
  }

  let { items, keyOf, label, texts, onmove, onremove, row }: Props = $props();

  let root: HTMLUListElement | undefined = $state();
  let dragFrom: number | undefined = $state();
  let dropAt: number | undefined = $state();

  /** After a move the button that was pressed may be disabled (the item is at an end): focus moves to its partner. */
  async function move(item: T, index: number, to: number, pressed: 'up' | 'down'): Promise<void> {
    const key = String(keyOf(item));
    onmove(index, to);
    await tick();
    const row = Array.from(root?.querySelectorAll<HTMLElement>('[data-key]') ?? []).find(
      (element) => element.dataset['key'] === key,
    );
    const wanted = row?.querySelector<HTMLButtonElement>(`[data-action="${pressed}"]`);
    const other = row?.querySelector<HTMLButtonElement>(
      `[data-action="${pressed === 'up' ? 'down' : 'up'}"]`,
    );
    (wanted?.disabled === false ? wanted : other?.disabled === false ? other : undefined)?.focus();
  }

  function ondragstart(event: DragEvent, index: number): void {
    dragFrom = index;
    const transfer = event.dataTransfer;
    if (transfer) {
      transfer.effectAllowed = 'move';
      transfer.setData('text/plain', String(index));
    }
  }

  function ondragover(event: DragEvent, index: number): void {
    if (dragFrom === undefined) {
      return;
    }
    event.preventDefault();
    const transfer = event.dataTransfer;
    if (transfer) {
      transfer.dropEffect = 'move';
    }
    dropAt = index;
  }

  function ondrop(event: DragEvent, index: number): void {
    if (dragFrom === undefined) {
      return;
    }
    event.preventDefault();
    const from = dragFrom;
    dragFrom = undefined;
    dropAt = undefined;
    if (from !== index) {
      onmove(from, index);
    }
  }

  function ondragend(): void {
    dragFrom = undefined;
    dropAt = undefined;
  }
</script>

<!--
  An ordered list whose items move with buttons (the keyboard and screen reader route) or by drag
  and drop (an extra). Keeps the focus on the button that was pressed. App-local: candidate for
  kern (#121, kern issue 68: SortableList). Drag and drop is an extra, the buttons are the keyboard route.
-->
<ul class="list" aria-label={label} bind:this={root}>
  {#each items as item, index (keyOf(item))}
    <li
      class="item"
      class:dragging={dragFrom === index}
      class:drop={dropAt === index && dragFrom !== index}
      data-key={keyOf(item)}
      draggable="true"
      ondragstart={(event) => {
        ondragstart(event, index);
      }}
      ondragover={(event) => {
        ondragover(event, index);
      }}
      ondrop={(event) => {
        ondrop(event, index);
      }}
      {ondragend}
    >
      <div class="row">{@render row(item, index)}</div>
      <div class="buttons">
        <Button
          variant="secondary"
          size="sm"
          data-action="up"
          aria-label={texts.upLabel(item)}
          disabled={index === 0}
          onclick={() => void move(item, index, index - 1, 'up')}>{texts.up}</Button
        >
        <Button
          variant="secondary"
          size="sm"
          data-action="down"
          aria-label={texts.downLabel(item)}
          disabled={index === items.length - 1}
          onclick={() => void move(item, index, index + 1, 'down')}>{texts.down}</Button
        >
        <Button
          variant="secondary"
          size="sm"
          data-action="remove"
          aria-label={texts.removeLabel(item)}
          onclick={() => {
            onremove(index);
          }}>{texts.remove}</Button
        >
      </div>
    </li>
  {/each}
</ul>

<style>
  .list {
    display: flex;
    flex-direction: column;
    gap: var(--k-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .item {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--k-space-3);
    padding: var(--k-space-3) var(--k-space-4);
    border: 1px solid var(--k-line-strong);
    cursor: grab;
  }

  .row {
    flex: 1 1 14rem;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: var(--k-space-2);
  }

  .dragging {
    opacity: 0.5;
  }

  .drop {
    border-style: dashed;
    border-color: var(--k-link);
  }
</style>
