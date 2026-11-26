<script lang="ts">
  import { Button, Mascot } from '@mozra-the-great/kern';
  import { t } from '../../i18n/index.ts';
  import { HOME_PATH } from '../routes.ts';
  import './page.css';
  import { MASCOT_URLS } from '../mascots.ts';
</script>

<section class="page">
  <Mascot name="boo" src={MASCOT_URLS.boo} scale={8} compactScale={6} />
  <h1 class="page-title">{t('notFound.title')}</h1>
  <div>
    <Button href={HOME_PATH} variant="secondary">{t('notFound.home')}</Button>
  </div>
</section>
