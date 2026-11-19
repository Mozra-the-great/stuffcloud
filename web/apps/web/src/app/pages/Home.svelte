<script lang="ts">
  import { t } from '../../i18n/index.ts';
  import LinkButton from '../../ui/LinkButton.svelte';
  import Mascot from '../../ui/Mascot.svelte';
  import { TOOLS_PATH } from '../routes.ts';
</script>

<section class="home">
  <div class="copy">
    <h1 class="title">{t('home.title')}</h1>
    <div>
      <LinkButton href={TOOLS_PATH}>{t('home.openTools')}</LinkButton>
    </div>
  </div>
  <div class="panel">
    <Mascot name="stuffy" scale={10} compactScale={7} />
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
    gap: var(--space-28);
    padding: 72px var(--space-40);
    border-right: 1px solid var(--line);
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
    background: var(--violet);
  }

  @media (max-width: 760px) {
    .copy {
      padding: var(--space-40) var(--space-16);
      border-right: 0;
      border-bottom: 1px solid var(--line);
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
