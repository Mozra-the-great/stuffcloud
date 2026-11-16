<script lang="ts">
  import Button from './Button.svelte';

  interface Props {
    code: string;
    /** Accessible name of the code region (it scrolls, so it is focusable). */
    label: string;
    /** Label of the copy button; leave unset for a block without one. */
    copyLabel?: string;
    /** Announced and shown after a successful copy. */
    copiedLabel?: string;
    /** Called with the outcome of every copy attempt. */
    oncopy?: (copied: boolean) => void;
  }

  let { code, label, copyLabel, copiedLabel, oncopy }: Props = $props();

  let copied = $state(false);
  let resetTimer: ReturnType<typeof setTimeout> | undefined;

  async function copy(): Promise<void> {
    let ok: boolean;
    try {
      await navigator.clipboard.writeText(code);
      ok = true;
    } catch {
      // No clipboard (insecure context) or permission denied.
      ok = false;
    }
    copied = ok;
    clearTimeout(resetTimer);
    if (ok) {
      resetTimer = setTimeout(() => {
        copied = false;
      }, 2000);
    }
    oncopy?.(ok);
  }
</script>

<div class="cb">
  {#if copyLabel !== undefined}
    <div class="head">
      <span class="status" role="status">{copied ? (copiedLabel ?? '') : ''}</span>
      <Button variant="ghost" size="compact" onclick={copy}>{copyLabel}</Button>
    </div>
  {/if}
  <!-- A scrollable region must be reachable by keyboard (axe: scrollable-region-focusable). -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <pre role="region" tabindex="0" aria-label={label}><code>{code}</code></pre>
</div>

<style>
  .cb {
    border: 1px solid var(--line2);
    background: var(--bg-code);
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-12);
    padding: var(--space-8) var(--space-8) var(--space-8) var(--space-16);
    border-bottom: 1px solid var(--line);
  }

  .status {
    font: 12px var(--mono);
    color: var(--green);
  }

  pre {
    margin: 0;
    padding: var(--space-16) 18px;
    font: 14px/1.7 var(--mono);
    color: var(--fg-code);
    overflow-x: auto;
    scrollbar-width: none;
  }

  pre::-webkit-scrollbar {
    display: none;
  }
</style>
