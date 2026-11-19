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
    gap: var(--space-16);
    padding: var(--space-28) var(--space-40) 36px;
    border-top: 1px solid var(--line);
    font-size: 13px;
    color: var(--mut);
  }

  .foot a {
    display: inline-flex;
    align-items: center;
    min-height: var(--target-min);
    color: var(--mut);
    text-decoration: underline;
  }

  .foot a:hover {
    color: var(--fg);
  }

  span {
    display: flex;
    gap: var(--space-24);
    flex-wrap: wrap;
  }

  @media (max-width: 760px) {
    .foot {
      flex-direction: column;
      padding: var(--space-24) var(--space-16) var(--space-32);
    }
  }
</style>
