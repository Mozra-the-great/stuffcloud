<script lang="ts">
  import { StatusMessage } from '@mozra-the-great/kern';

  interface Props {
    /** What happened or is happening: working, done, cancelled (announced politely). */
    status: string;
    /** What went wrong (announced at once). */
    error: string;
  }

  let { status, error }: Props = $props();
</script>

<!--
  The two live regions of a tool: kern's StatusMessage twice, one polite and one assertive. They are
  in the page from the start, empty, and get their text later (a region that arrives together with its
  text is not announced by every screen reader). The PDF layout never reserved a line for them, so
  `reserve` is off; a message of the error region gets a box (the design's error edge).
-->
<div class="live">
  <StatusMessage message={status} reserve={false} />
  <StatusMessage
    kind="alert"
    message={error}
    reserve={false}
    class={error === '' ? 'live-error' : 'live-error has-error'}
  />
</div>

<style>
  .live {
    display: flex;
    flex-direction: column;
    gap: var(--space-8);
  }

  .live :global(.live-error.has-error) {
    padding: var(--space-12) var(--space-16);
    border: 1px solid var(--k-danger);
  }
</style>
