<script lang="ts">
  import { LiveAnnouncer, OnlineStatus, SkipLink, Toaster } from '@mozra-the-great/kern';
  import { t } from '../i18n/index.ts';
  import { provideTools } from './context.ts';
  import Footer from './Footer.svelte';
  import Header from './Header.svelte';
  import Outlet from './Outlet.svelte';
  import type { Router } from './router/router.svelte.ts';
  import SearchDialog from './SearchDialog.svelte';
  import { isSearchShortcut, searchShortcutLabel } from './shortcut.ts';
  import type { ToolEntry } from './tools.ts';

  interface Props {
    router: Router;
    tools: readonly ToolEntry[];
  }

  let { router, tools }: Props = $props();

  provideTools(() => tools);

  // Set after mount by kern's `OnlineStatus` (`bind:online`); the page is assumed online until then.
  let online = $state(true);
  const shortcut = searchShortcutLabel(navigator.userAgent);
  let searchOpen = $state(false);

  // The router's listeners live as long as the shell: link clicks, back/forward.
  $effect(() => router.start());

  function onKeydown(event: KeyboardEvent): void {
    if (isSearchShortcut(event)) {
      event.preventDefault();
      searchOpen = true;
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<SkipLink target="main" label={t('skip.toContent')} />
<!-- Before OnlineStatus: that component announces through the first live region that is mounted. -->
<LiveAnnouncer />
<div class="frame">
  <Header
    currentPath={router.current.path}
    {shortcut}
    onsearch={() => {
      searchOpen = true;
    }}
  />
  <OnlineStatus
    bind:online
    offlineTitle={t('offline.title')}
    offlineText={t('offline.hint')}
    onlineText={t('offline.back')}
  />
  <Outlet {router} offline={!online} />
  <Footer />
</div>
<SearchDialog
  bind:open={searchOpen}
  {tools}
  onnavigate={(href: string) => {
    router.navigate(href);
  }}
/>
<Toaster position="bottom-left" label={t('toast.region')} dismissLabel={t('toast.dismiss')} />

<style>
  .frame {
    display: flex;
    flex-direction: column;
    max-width: 1240px;
    min-height: 100vh;
    margin: 0 auto;
    border-left: 1px solid var(--k-line);
    border-right: 1px solid var(--k-line);
  }
</style>
