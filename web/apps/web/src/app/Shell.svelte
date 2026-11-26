<script lang="ts">
  import { Toaster } from '@mozra-the-great/kern';
  import { t } from '../i18n/index.ts';
  import { Announcer } from './announcer.svelte.ts';
  import { provideTools } from './context.ts';
  import Footer from './Footer.svelte';
  import Header from './Header.svelte';
  import LiveAnnouncer from './LiveAnnouncer.svelte';
  import OfflineNotice from './OfflineNotice.svelte';
  import { OnlineStatus } from './online.svelte.ts';
  import Outlet from './Outlet.svelte';
  import type { Router } from './router/router.svelte.ts';
  import SearchDialog from './SearchDialog.svelte';
  import { isSearchShortcut, searchShortcutLabel } from './shortcut.ts';
  import SkipLink from './SkipLink.svelte';
  import type { ToolEntry } from './tools.ts';

  interface Props {
    router: Router;
    tools: readonly ToolEntry[];
  }

  let { router, tools }: Props = $props();

  provideTools(() => tools);

  const announcer = new Announcer();
  const status = new OnlineStatus();
  const shortcut = searchShortcutLabel(navigator.userAgent);
  let searchOpen = $state(false);

  // Listeners live as long as the shell: link clicks, back/forward, connection changes.
  $effect(() => {
    const stopRouter = router.start();
    const stopStatus = status.start();
    return (): void => {
      stopRouter();
      stopStatus();
    };
  });

  function onKeydown(event: KeyboardEvent): void {
    if (isSearchShortcut(event)) {
      event.preventDefault();
      searchOpen = true;
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<SkipLink target="main" label={t('skip.toContent')} />
<div class="frame">
  <Header
    currentPath={router.current.path}
    {shortcut}
    onsearch={() => {
      searchOpen = true;
    }}
  />
  <OfflineNotice online={status.online} />
  <Outlet {router} offline={!status.online} {announcer} />
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
<LiveAnnouncer {announcer} />

<style>
  .frame {
    display: flex;
    flex-direction: column;
    max-width: 1240px;
    min-height: 100vh;
    margin: 0 auto;
    border-left: 1px solid var(--line);
    border-right: 1px solid var(--line);
  }
</style>
