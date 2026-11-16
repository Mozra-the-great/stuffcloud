<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';

  interface Props extends Omit<HTMLAttributes<HTMLElement>, 'class' | 'children'> {
    children: Snippet;
  }

  let { children, ...rest }: Props = $props();
</script>

<div {...rest} class="cells">
  {@render children()}
</div>

<style>
  .cells {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    border-top: 1px solid var(--line);
  }
</style>
