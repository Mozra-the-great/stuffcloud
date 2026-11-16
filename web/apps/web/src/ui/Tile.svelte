<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLAnchorAttributes, HTMLAttributes } from 'svelte/elements';

  interface Props extends Omit<HTMLAttributes<HTMLElement>, 'class' | 'children'> {
    /** Makes the whole tile a link. */
    href?: string;
    children: Snippet;
  }

  let { href, children, ...rest }: Props = $props();
</script>

<!-- A grid cell: lines on the right and bottom, so a TileGrid draws the thin grid. -->
{#if href !== undefined}
  <a {...rest as HTMLAnchorAttributes} {href} class="cell">
    {@render children()}
  </a>
{:else}
  <div {...rest} class="cell">
    {@render children()}
  </div>
{/if}

<style>
  .cell {
    display: flex;
    flex-direction: column;
    gap: 40px;
    padding: var(--space-28) var(--space-32) var(--space-32);
    border-right: 1px solid var(--line);
    border-bottom: 1px solid var(--line);
  }

  a.cell:hover {
    background: var(--bg-raised);
  }

  @media (max-width: 760px) {
    .cell {
      flex-direction: row;
      align-items: center;
      gap: var(--space-20);
      padding: var(--space-20) var(--space-16);
    }
  }
</style>
