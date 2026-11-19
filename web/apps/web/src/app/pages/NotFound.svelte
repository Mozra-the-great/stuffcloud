<script lang="ts">
  import { t } from '../../i18n/index.ts';
  import LinkButton from '../../ui/LinkButton.svelte';
  import Mascot from '../../ui/Mascot.svelte';
  import { HOME_PATH } from '../routes.ts';
  import './page.css';
</script>

<section class="page">
  <Mascot name="boo" scale={8} compactScale={6} />
  <h1 class="page-title">{t('notFound.title')}</h1>
  <div>
    <LinkButton href={HOME_PATH} variant="ghost">{t('notFound.home')}</LinkButton>
  </div>
</section>
