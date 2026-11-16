<script lang="ts">
  import Button from './Button.svelte';
  import { toaster as defaultToaster, type Toast, type Toaster } from './toast.svelte.ts';

  interface Props {
    /** Accessible name of the region. */
    label: string;
    /** Accessible name of each toast's dismiss button. */
    dismissLabel: string;
    toaster?: Toaster;
  }

  let { label, dismissLabel, toaster = defaultToaster }: Props = $props();
</script>

{#snippet item(toast: Toast)}
  <div
    class="toast {toast.kind}"
    role="group"
    onmouseenter={() => {
      toaster.pause(toast.id);
    }}
    onmouseleave={() => {
      toaster.resume(toast.id);
    }}
    onfocusin={() => {
      toaster.pause(toast.id);
    }}
    onfocusout={() => {
      toaster.resume(toast.id);
    }}
  >
    <span class="message">{toast.message}</span>
    <Button
      variant="ghost"
      size="icon"
      aria-label={dismissLabel}
      onclick={() => {
        toaster.dismiss(toast.id);
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
{/snippet}

<!-- Both live regions exist from the start, so screen readers announce what is added to them:
     errors interrupt (alert), everything else waits its turn (status). -->
<section class="region" aria-label={label}>
  <div class="list" role="status" aria-atomic="false">
    {#each toaster.items.filter((toast) => toast.kind !== 'error') as toast (toast.id)}
      {@render item(toast)}
    {/each}
  </div>
  <div class="list" role="alert" aria-atomic="false">
    {#each toaster.items.filter((toast) => toast.kind === 'error') as toast (toast.id)}
      {@render item(toast)}
    {/each}
  </div>
</section>

<style>
  /* Bottom left; the theme button owns the bottom right corner. */
  .region {
    position: fixed;
    left: var(--space-16);
    bottom: var(--space-16);
    z-index: 70;
    display: flex;
    flex-direction: column;
    gap: var(--space-10);
    width: min(420px, calc(100vw - 32px));
    pointer-events: none;
  }

  .list {
    display: flex;
    flex-direction: column;
    gap: var(--space-10);
  }

  .toast {
    display: flex;
    align-items: center;
    gap: var(--space-12);
    padding: var(--space-8) var(--space-8) var(--space-8) var(--space-16);
    background: var(--bg-raised);
    border: 1px solid var(--line2);
    border-radius: var(--radius);
    box-shadow: 4px 4px 0 var(--shadow);
    font-size: 15px;
    line-height: 1.5;
    pointer-events: auto;
  }

  .message {
    flex: 1 1 auto;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .success {
    border-color: var(--green);
  }

  .warn {
    border-color: var(--amber);
    background: var(--bg-warn);
  }

  .error {
    border-color: var(--pink2);
    background: var(--bg-error);
  }

  @media (max-width: 760px) {
    .region {
      bottom: 76px;
    }
  }
</style>
