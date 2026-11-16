<script lang="ts">
  import type { Snippet } from 'svelte';
  import Button from './Button.svelte';

  interface Props {
    /** Two-way: set to `true` to open, becomes `false` when the dialog closes. */
    open?: boolean;
    /** Heading and accessible name of the dialog. */
    title: string;
    /** Accessible name of the close button (a dialog always has a visible way out). */
    closeLabel: string;
    /** Clicking the backdrop closes the dialog. Escape always closes it. */
    dismissOnBackdrop?: boolean;
    onclose?: (() => void) | undefined;
    children: Snippet;
    /** Buttons row at the bottom. */
    actions?: Snippet;
  }

  let {
    open = $bindable(false),
    title,
    closeLabel,
    dismissOnBackdrop = true,
    onclose,
    children,
    actions,
  }: Props = $props();

  const uid = $props.id();
  const titleId = $derived(`${uid}-title`);
  let dialog: HTMLDialogElement | undefined = $state();

  // Native <dialog>: showModal() gives the focus trap, inert background, Escape handling
  // and focus restore for free; this effect only keeps it in sync with `open`.
  $effect(() => {
    if (dialog === undefined) {
      return;
    }
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  });

  function handleClose(): void {
    open = false;
    onclose?.();
  }

  // The backdrop is the <dialog> element itself; the content sits in the inner wrapper.
  function handleClick(event: MouseEvent & { currentTarget: HTMLDialogElement }): void {
    if (dismissOnBackdrop && event.target === event.currentTarget) {
      event.currentTarget.close();
    }
  }
</script>

<dialog bind:this={dialog} aria-labelledby={titleId} onclose={handleClose} onclick={handleClick}>
  <div class="body">
    <div class="head">
      <h2 id={titleId}>{title}</h2>
      <Button
        variant="ghost"
        size="icon"
        aria-label={closeLabel}
        onclick={() => {
          dialog?.close();
        }}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"
        >
          <path d="M1 1l12 12M13 1L1 13" />
        </svg>
      </Button>
    </div>
    {@render children()}
    {#if actions !== undefined}
      <div class="actions">
        {@render actions()}
      </div>
    {/if}
  </div>
</dialog>

<style>
  dialog {
    width: min(480px, calc(100vw - 32px));
    max-height: calc(100vh - 32px);
    padding: 0;
    overflow: auto;
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--line2);
    border-radius: var(--radius);
    box-shadow: 8px 8px 0 var(--shadow);
  }

  dialog::backdrop {
    background: color-mix(in srgb, var(--bg) 80%, transparent);
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: var(--space-20);
    padding: var(--space-20);
  }

  .head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-16);
  }

  h2 {
    margin: 0;
    font-size: 22px;
    font-weight: 500;
    line-height: 1.2;
    overflow-wrap: anywhere;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--space-10);
  }

  @media (max-width: 760px) {
    .actions {
      flex-direction: column;
      align-items: stretch;
    }
  }
</style>
