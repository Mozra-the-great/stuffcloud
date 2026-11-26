<script lang="ts">
  import { t } from '../i18n/index.ts';
  import { APP_NAME, SOURCE_URL } from './brand.ts';
</script>

<footer class="foot">
  <div>{APP_NAME} · {t('footer.tagline')}</div>
  <span><a href={SOURCE_URL} rel="external noopener">{t('footer.source')}</a></span>
</footer>

<style>
  .foot {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: var(--k-space-4);
    padding: var(--k-space-6-5) var(--k-space-8) 36px;
    border-top: 1px solid var(--k-line);
    font-size: 13px;
    color: var(--k-fg-muted);
  }

  .foot a {
    display: inline-flex;
    align-items: center;
    min-height: var(--k-tap-min);
    color: var(--k-fg-muted);
    text-decoration: underline;
  }

  .foot a:hover {
    color: var(--k-fg);
  }

  span {
    display: flex;
    gap: var(--k-space-6);
    flex-wrap: wrap;
  }

  @media (max-width: 760px) {
    .foot {
      flex-direction: column;
      padding: var(--k-space-6) var(--k-space-4) var(--k-space-7);
    }
  }
</style>
