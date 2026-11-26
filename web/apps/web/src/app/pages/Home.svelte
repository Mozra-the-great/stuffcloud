<script lang="ts">
  import { Button, Mascot } from '@mozra-the-great/kern';
  import { t } from '../../i18n/index.ts';
  import { TOOLS_PATH } from '../routes.ts';
  import { MASCOT_URLS } from '../mascots.ts';
</script>

<section class="home">
  <div class="copy">
    <h1 class="title">{t('home.title')}</h1>
    <div>
      <Button href={TOOLS_PATH}>{t('home.openTools')}</Button>
    </div>
  </div>
  <div class="panel">
    <Mascot name="stuffy" src={MASCOT_URLS.stuffy} scale={10} compactScale={7} />
  </div>
</section>

<style>
  .home {
    display: flex;
    flex-wrap: wrap;
  }

  .copy {
    flex: 1 1 360px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: var(--k-space-6-5);
    padding: 72px var(--k-space-8);
    border-right: 1px solid var(--k-line);
  }

  .title {
    margin: 0;
    font-size: 64px;
    font-weight: 500;
    letter-spacing: -1.5px;
    line-height: 1.04;
    overflow-wrap: anywhere;
  }

  .copy > div {
    align-self: flex-start;
  }

  .panel {
    flex: 1 1 360px;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 320px;
    background: var(--sc-stage);
  }

  @media (max-width: 760px) {
    .copy {
      padding: var(--k-space-8) var(--k-space-4);
      border-right: 0;
      border-bottom: 1px solid var(--k-line);
    }

    .title {
      font-size: 40px;
      letter-spacing: -1px;
    }

    .panel {
      min-height: 220px;
    }
  }
</style>
