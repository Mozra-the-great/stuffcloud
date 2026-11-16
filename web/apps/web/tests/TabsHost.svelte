<script lang="ts">
  import Tabs from '../src/ui/Tabs.svelte';
  import type { TabItem } from '../src/ui/types.ts';

  interface Props {
    tabs: readonly TabItem[];
    label: string;
    selected?: string;
  }

  let { tabs, label, selected = $bindable() }: Props = $props();
</script>

<Tabs {tabs} {label} bind:selected>
  {#snippet panel(item: TabItem)}
    <p>panel: {item.label}</p>
  {/snippet}
</Tabs>
<output data-testid="bound">{selected ?? 'unset'}</output>
