<script lang="ts">
  import { t } from '../i18n/index.ts';

  interface Props {
    online: boolean;
  }

  let { online }: Props = $props();
</script>

<!-- The live region is always there; only its content comes and goes, so the change is announced. -->
<div class="region" role="status">
  {#if !online}
    <div class="notice">
      <strong>{t('offline.title')}</strong>
      <span>{t('offline.hint')}</span>
    </div>
  {/if}
</div>

<style>
  .notice {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-8) var(--space-16);
    padding: var(--space-12) var(--space-24);
    border-bottom: 1px solid var(--amber);
    background: var(--bg-warn);
    font-size: 15px;
    line-height: 1.5;
  }

  @media (max-width: 760px) {
    .notice {
      padding: var(--space-12) var(--space-16);
    }
  }
</style>
