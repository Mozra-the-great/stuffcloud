<script lang="ts">
  import './tabs.css';
  import type { TabLink } from './types.ts';

  interface Props {
    links: readonly TabLink[];
    /** Accessible name of the navigation landmark. */
    label: string;
  }

  let { links, label }: Props = $props();
</script>

<nav class="sc-tabs" aria-label={label}>
  {#each links as link (link.href)}
    <a class="sc-tab" href={link.href} aria-current={link.current === true ? 'page' : undefined}>
      {link.label}
    </a>
  {/each}
</nav>
