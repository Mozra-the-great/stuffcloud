<script lang="ts">
  import { i18n, LOCALES, LOCALE_NAMES, t } from '../i18n/index.ts';
  import Button from '../ui/Button.svelte';
</script>

<div class="lang" role="group" aria-label={t('language.label')}>
  {#each LOCALES as locale (locale)}
    <Button
      variant="ghost"
      size="compact"
      lang={locale}
      aria-pressed={i18n.locale === locale}
      onclick={() => {
        i18n.setLocale(locale);
      }}
    >
      {LOCALE_NAMES[locale]}
    </Button>
  {/each}
</div>

<style>
  .lang {
    display: flex;
    gap: var(--space-8);
  }

  .lang :global(.sc-btn[aria-pressed='true']) {
    border-color: var(--pink);
    color: var(--pink);
  }
</style>
