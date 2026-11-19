<script lang="ts">
  import type { Announcer } from './announcer.svelte.ts';

  interface Props {
    announcer: Announcer;
  }

  let { announcer }: Props = $props();
</script>

<!-- Candidate for kern (#121): visually hidden polite live region. Rendered once, before any text. -->
<div class="announcer" role="status" aria-live="polite" aria-atomic="true">{announcer.message}</div>

<style>
  .announcer {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }
</style>
