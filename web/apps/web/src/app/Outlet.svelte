<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { i18n, t } from '../i18n/index.ts';
  import Progress from '../ui/Progress.svelte';
  import type { Announcer } from './announcer.svelte.ts';
  import ErrorState from './ErrorState.svelte';
  import { documentTitle, focusHeading, headingText } from './focus.ts';
  import type { ResolvedRoute, RouteComponent, Router } from './router/router.svelte.ts';

  interface Props {
    router: Router;
    /** The browser reports no connection (changes the wording of a load failure). */
    offline: boolean;
    announcer: Announcer;
    /** How long a page may load before the progress bar shows (no flash for cached chunks). */
    progressDelayMs?: number;
  }

  let { router, offline, announcer, progressDelayMs = 150 }: Props = $props();

  interface View {
    readonly component: RouteComponent;
    readonly target: ResolvedRoute;
  }

  let main: HTMLElement | undefined = $state();
  let view: View | undefined = $state.raw();
  let loading = $state(false);
  let showProgress = $state(false);
  let loadFailed = $state(false);

  // Not reactive: bookkeeping of the load that is current.
  let generation = 0;
  let shownPath: string | undefined;
  let progressTimer: ReturnType<typeof setTimeout> | undefined;

  function stopProgress(): void {
    clearTimeout(progressTimer);
    progressTimer = undefined;
    showProgress = false;
  }

  async function load(target: ResolvedRoute): Promise<void> {
    const mine = ++generation;
    // After a failure the visitor is on the error page: bring focus to whatever shows next.
    const recovering = loadFailed;
    loading = true;
    loadFailed = false;
    clearTimeout(progressTimer);
    progressTimer = setTimeout(() => {
      showProgress = true;
    }, progressDelayMs);

    let component: RouteComponent;
    try {
      // A page without props ignores the ones it is given: calling it with them is safe.
      component = (await target.route.load()).default as RouteComponent;
    } catch {
      if (mine === generation) {
        view = undefined;
        loadFailed = true;
        loading = false;
        stopProgress();
      }
      return;
    }
    if (mine !== generation) {
      return;
    }
    const navigated = shownPath !== undefined && shownPath !== target.path;
    view = { component, target };
    loading = false;
    stopProgress();
    await tick();
    if (mine !== generation || main === undefined) {
      return;
    }
    shownPath = target.path;
    if (navigated || recovering) {
      focusHeading(main);
      window.scrollTo(0, 0);
      announcer.announce(t('status.navigated', { title: headingText(main) }));
    }
  }

  // Every change of address (path or query) loads the matching route.
  $effect(() => {
    const target = router.current;
    untrack(() => {
      void load(target);
    });
    return (): void => {
      clearTimeout(progressTimer);
    };
  });

  // The tab title follows the heading, also when the language changes.
  let titleSignature = '';
  function syncTitle(signature: string): void {
    if (signature === titleSignature) {
      return;
    }
    titleSignature = signature;
    void tick().then(() => {
      if (main !== undefined) {
        document.title = documentTitle(headingText(main));
      }
    });
  }

  $effect(() => {
    syncTitle(`${i18n.locale}|${String(loadFailed)}|${view?.target.path ?? ''}`);
  });
</script>

<main id="main" tabindex="-1" aria-busy={loading} bind:this={main}>
  {#if showProgress}
    <div class="loading">
      <Progress label={t('status.loading')} />
    </div>
  {/if}
  {#if loadFailed}
    <ErrorState {offline} onretry={() => void load(router.current)} />
  {:else if view !== undefined}
    {#key view.target.path}
      <svelte:boundary>
        <view.component params={view.target.params} query={view.target.query} />
        {#snippet failed(error, reset)}
          <ErrorState {offline} cause={error} onretry={reset} />
        {/snippet}
      </svelte:boundary>
    {/key}
  {/if}
</main>

<style>
  main {
    flex: 1;
    display: flex;
    flex-direction: column;
    outline: none;
  }

  .loading {
    position: sticky;
    top: 0;
    z-index: 10;
  }
</style>
