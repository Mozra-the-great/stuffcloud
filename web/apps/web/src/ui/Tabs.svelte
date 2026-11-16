<script lang="ts">
  import type { Snippet } from 'svelte';
  import './tabs.css';
  import { nextTabIndex } from './tabs-nav.ts';
  import type { TabItem } from './types.ts';

  interface Props {
    tabs: readonly TabItem[];
    /** Accessible name of the tab list. */
    label: string;
    /** Id of the selected tab; falls back to the first tab when unset or unknown. */
    selected?: string | undefined;
    /** Renders the panel of the selected tab. */
    panel: Snippet<[TabItem]>;
  }

  let { tabs, label, selected = $bindable(), panel }: Props = $props();

  const uid = $props.id();
  const current = $derived(tabs.find((tab) => tab.id === selected) ?? tabs[0]);
  const buttons: Record<string, HTMLButtonElement | undefined> = $state({});

  function tabId(tab: TabItem): string {
    return `${uid}-tab-${tab.id}`;
  }

  function panelId(tab: TabItem): string {
    return `${uid}-panel-${tab.id}`;
  }

  /** Arrow keys, Home and End move the selection (WAI-ARIA tabs pattern, automatic activation). */
  function onkeydown(event: KeyboardEvent, from: TabItem): void {
    const next = nextTabIndex(event.key, tabs.indexOf(from), tabs.length);
    if (next === undefined) {
      return;
    }
    event.preventDefault();
    const target = tabs[next];
    if (target !== undefined) {
      selected = target.id;
      buttons[target.id]?.focus();
    }
  }
</script>

<div class="sc-tabs" role="tablist" aria-label={label}>
  {#each tabs as tab (tab.id)}
    <button
      bind:this={buttons[tab.id]}
      type="button"
      role="tab"
      id={tabId(tab)}
      class="sc-tab"
      aria-selected={tab === current}
      aria-controls={panelId(tab)}
      tabindex={tab === current ? 0 : -1}
      onclick={() => {
        selected = tab.id;
      }}
      onkeydown={(event) => {
        onkeydown(event, tab);
      }}
    >
      {tab.label}
    </button>
  {/each}
</div>
{#if current !== undefined}
  <div role="tabpanel" id={panelId(current)} aria-labelledby={tabId(current)} tabindex="0">
    {@render panel(current)}
  </div>
{/if}
