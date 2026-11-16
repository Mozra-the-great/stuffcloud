<script lang="ts">
  import Dialog from '../src/ui/Dialog.svelte';

  interface Props {
    open?: boolean;
    withActions?: boolean;
    dismissOnBackdrop?: boolean;
    onclose?: (() => void) | undefined;
  }

  let {
    open = $bindable(false),
    withActions = true,
    dismissOnBackdrop = true,
    onclose,
  }: Props = $props();
</script>

{#if withActions}
  <Dialog bind:open title="Delete site" closeLabel="Close" {dismissOnBackdrop} {onclose}>
    <p>my-site.example</p>
    {#snippet actions()}
      <button type="button">Confirm</button>
    {/snippet}
  </Dialog>
{:else}
  <Dialog bind:open title="Delete site" closeLabel="Close" {dismissOnBackdrop} {onclose}>
    <p>my-site.example</p>
  </Dialog>
{/if}

<output data-testid="open">{open ? 'open' : 'closed'}</output>
