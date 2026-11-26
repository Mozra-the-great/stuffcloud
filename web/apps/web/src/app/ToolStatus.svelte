<script lang="ts">
  interface Props {
    /** The text; empty until there is something to say. */
    message: string;
    /** `status` is polite (a result); `alert` interrupts (an error). */
    kind?: 'status' | 'alert';
  }

  let { message, kind = 'status' }: Props = $props();
</script>

<!--
  Candidate for kern (#121): a visible live region for the result of a tool (kern issue #72; #64 has
  the hidden variant, LiveAnnouncer). Rendered from the first paint, empty, so that a screen reader
  has it registered before the first text arrives.
-->
<p class="tool-status" class:alert={kind === 'alert'} role={kind}>{message}</p>

<style>
  .tool-status {
    margin: 0;
    min-height: 1.5em;
    font: 14px/1.5 var(--k-font-mono);
    color: var(--k-ok);
  }

  .tool-status.alert {
    color: var(--k-danger);
  }
</style>
