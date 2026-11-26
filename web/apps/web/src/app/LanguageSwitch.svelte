<script lang="ts">
  import { Button } from '@mozra-the-great/kern';
  import { i18n, LOCALES, LOCALE_NAMES, t } from '../i18n/index.ts';
</script>

<div class="lang" role="group" aria-label={t('language.label')}>
  {#each LOCALES as locale (locale)}
    <Button
      variant="secondary"
      size="sm"
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

  /* `[data-variant]` (kern's variant attribute) keeps the current language pink on hover too. */
  .lang :global(.k-button[data-variant][aria-pressed='true']) {
    border-color: var(--pink);
    color: var(--pink);
  }
</style>
