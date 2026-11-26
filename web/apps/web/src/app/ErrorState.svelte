<script lang="ts">
  import { Mascot } from '@mozra-the-great/kern';
  import { t } from '../i18n/index.ts';
  import Button from '../ui/Button.svelte';
  import './pages/page.css';
  import { MASCOT_URLS } from './mascots.ts';

  interface Props {
    /** The browser reports no connection: say so instead of a generic failure. */
    offline: boolean;
    onretry: () => void;
    /** What was thrown, if anything; only its type name is exposed (`data-cause`), never its message. */
    cause?: unknown;
  }

  let { offline, onretry, cause }: Props = $props();

  let heading: HTMLHeadingElement | undefined = $state();

  // A failure replaces the page the visitor was waiting for: bring them to it.
  $effect(() => {
    heading?.focus({ preventScroll: true });
  });
</script>

<section class="page" data-cause={cause instanceof Error ? cause.name : undefined}>
  <Mascot name="cumulo" src={MASCOT_URLS.cumulo} scale={8} compactScale={6} />
  <h1 class="page-title" tabindex="-1" bind:this={heading}>
    {offline ? t('offline.title') : t('error.title')}
  </h1>
  {#if offline}
    <p class="hint">{t('offline.hint')}</p>
  {/if}
  <div>
    <Button variant="ghost" onclick={onretry}>{t('error.retry')}</Button>
  </div>
</section>

<style>
  .hint {
    margin: 0;
    font: 13px var(--mono);
    color: var(--mut);
  }
</style>
