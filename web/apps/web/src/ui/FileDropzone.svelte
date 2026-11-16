<script lang="ts">
  import Button from './Button.svelte';
  import { splitFiles } from './accept.ts';

  interface Props {
    /** Hint text, for example "drop PDFs here". */
    hint: string;
    /** Label of the button that opens the file picker. */
    buttonLabel: string;
    /** Same grammar as `<input accept>`: `.pdf`, `image/*`, `application/pdf`. */
    accept?: string;
    multiple?: boolean;
    disabled?: boolean;
    /** Files that were chosen or dropped and match `accept`. Only names and types are read here. */
    onfiles: (files: File[]) => void;
    /** Dropped files that did not match `accept` (the picker filters by itself). */
    onreject?: (files: File[]) => void;
  }

  let {
    hint,
    buttonLabel,
    accept,
    multiple = true,
    disabled = false,
    onfiles,
    onreject,
  }: Props = $props();

  const uid = $props.id();
  const hintId = $derived(`${uid}-hint`);
  let input: HTMLInputElement | undefined = $state();
  let dragging = $state(false);

  function deliver(files: readonly File[]): void {
    const { accepted, rejected } = splitFiles(files, accept, multiple);
    if (rejected.length > 0) {
      onreject?.(rejected);
    }
    if (accepted.length > 0) {
      onfiles(accepted);
    }
  }

  function onchange(event: Event & { currentTarget: HTMLInputElement }): void {
    const picker = event.currentTarget;
    deliver(Array.from(picker.files ?? []));
    // Picking the same file twice must fire again.
    picker.value = '';
  }

  function ondragover(event: DragEvent): void {
    if (disabled) {
      return;
    }
    event.preventDefault();
    const transfer = event.dataTransfer;
    if (transfer) {
      transfer.dropEffect = 'copy';
    }
    dragging = true;
  }

  function ondragleave(event: DragEvent): void {
    const next = event.relatedTarget;
    if (
      next instanceof Node &&
      event.currentTarget instanceof Node &&
      event.currentTarget.contains(next)
    ) {
      return;
    }
    dragging = false;
  }

  function ondrop(event: DragEvent): void {
    if (disabled) {
      return;
    }
    event.preventDefault();
    dragging = false;
    deliver(Array.from(event.dataTransfer?.files ?? []));
  }
</script>

<div
  class="dz"
  class:dragging
  role="group"
  aria-labelledby={hintId}
  {ondragover}
  {ondragleave}
  {ondrop}
>
  <span class="hint" id={hintId}>{hint}</span>
  <Button
    size="compact"
    {disabled}
    onclick={() => {
      input?.click();
    }}
  >
    {buttonLabel}
  </Button>
  <input
    bind:this={input}
    type="file"
    hidden
    tabindex="-1"
    {accept}
    {multiple}
    {disabled}
    {onchange}
  />
</div>

<style>
  .dz {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-16);
    padding: var(--space-24) var(--space-28);
    border: 1px dashed var(--line-drop);
    border-radius: var(--radius);
  }

  .dz.dragging {
    border-color: var(--pink);
    background: var(--bg-selected);
  }

  .hint {
    font: 14px var(--mono);
    color: var(--fg-hint);
  }

  @media (forced-colors: active) {
    .dz {
      border-color: CanvasText;
    }

    .dz.dragging {
      border-color: Highlight;
      border-style: solid;
    }
  }
</style>
