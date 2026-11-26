<script lang="ts">
  import { Button } from '@mozra-the-great/kern';
  import { t } from '../../i18n/index.ts';
  import Mascot from '../../ui/Mascot.svelte';
  import { HOME_PATH } from '../routes.ts';
  import './page.css';
</script>

<section class="page">
  <Mascot name="boo" scale={8} compactScale={6} />
  <h1 class="page-title">{t('notFound.title')}</h1>
  <div>
    <Button href={HOME_PATH} variant="secondary">{t('notFound.home')}</Button>
  </div>
</section>
