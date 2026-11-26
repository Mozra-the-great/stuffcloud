<script lang="ts">
  interface Props {
    /** What happened or is happening: working, done, cancelled (announced politely). */
    status: string;
    /** What went wrong (announced at once). */
    error: string;
  }

  let { status, error }: Props = $props();
</script>

<!--
  The two live regions of a tool. They are in the page from the start, empty, and get their text
  later (a region that arrives together with its text is not announced by every screen reader).
  App-local: covered by the LiveAnnouncer primitive of kern (#64).
-->
<div class="live">
  <p class="status" role="status">{status}</p>
  <p class="error" role="alert">{error}</p>
</div>

<style>
  .live {
    display: flex;
    flex-direction: column;
    gap: var(--k-space-2);
  }

  p {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .status {
    color: var(--k-fg);
  }

  .error {
    color: var(--k-accent);
  }

  .error:not(:empty) {
    padding: var(--k-space-3) var(--k-space-4);
    border: 1px solid var(--k-accent);
  }
</style>
