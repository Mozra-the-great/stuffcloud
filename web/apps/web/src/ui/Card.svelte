<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';

  interface Props extends Omit<HTMLAttributes<HTMLElement>, 'class' | 'children'> {
    /** Element to render; `li` for cards in a list. */
    tag?: 'div' | 'section' | 'article' | 'li';
    children: Snippet;
  }

  let { tag = 'div', children, ...rest }: Props = $props();
</script>

<svelte:element this={tag} {...rest} class="card">
  {@render children()}
</svelte:element>

<style>
  .card {
    display: flex;
    flex-direction: column;
    gap: var(--space-10);
    padding: var(--space-20);
    border: 1px solid var(--line2);
    border-radius: var(--radius);
  }
</style>
