<script lang="ts">
  import { t } from '../i18n/index.ts';
  import Button from '../ui/Button.svelte';
  import logoUrl from '../../../../../docs/design/prototypes/logo.svg?url';
  import { APP_NAME } from './brand.ts';
  import LanguageSwitch from './LanguageSwitch.svelte';
  import { TOOLS_PATH } from './routes.ts';

  interface Props {
    /** Normalised path of the page on screen, for `aria-current`. */
    currentPath: string;
    /** What the search button shows as its shortcut hint. */
    shortcut: string;
    onsearch: () => void;
  }

  let { currentPath, shortcut, onsearch }: Props = $props();

  // The phone menu is open for one page only: a navigation closes it.
  let openFor: string | undefined = $state();
  const menuOpen = $derived(openFor === currentPath);
  let menuButton: HTMLButtonElement | undefined = $state();
  const toolsCurrent = $derived(
    currentPath === TOOLS_PATH || currentPath.startsWith(`${TOOLS_PATH}/`),
  );

  function closeOnEscape(event: KeyboardEvent): void {
    if (event.key === 'Escape' && menuOpen) {
      openFor = undefined;
      menuButton?.focus();
    }
  }
</script>

{#snippet links()}
  <a href={TOOLS_PATH} aria-current={toolsCurrent ? 'page' : undefined}>{t('nav.tools')}</a>
{/snippet}

{#snippet actions()}
  <Button
    variant="ghost"
    size="compact"
    aria-keyshortcuts="Control+K Meta+K"
    onclick={() => {
      openFor = undefined;
      onsearch();
    }}
  >
    {t('search.open')}
    <kbd>{shortcut}</kbd>
  </Button>
  <LanguageSwitch />
{/snippet}

<svelte:window onkeydown={closeOnEscape} />

<header class="hdr">
  <div class="bar">
    <div class="left">
      <a class="brand" href="/">
        <img src={logoUrl} alt="" width="42" height="21" />
        <span>{APP_NAME}</span>
      </a>
      <nav class="nav wide" aria-label={t('nav.main')}>
        {@render links()}
      </nav>
    </div>
    <div class="right wide">
      {@render actions()}
    </div>
    <button
      class="menu-btn"
      type="button"
      aria-expanded={menuOpen}
      aria-controls="phone-menu"
      aria-label={menuOpen ? t('nav.menuClose') : t('nav.menuOpen')}
      bind:this={menuButton}
      onclick={() => {
        openFor = menuOpen ? undefined : currentPath;
      }}
    >
      <svg
        width="20"
        height="14"
        viewBox="0 0 20 14"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        aria-hidden="true"
      >
        <path d={menuOpen ? 'M2 1l16 12M18 1L2 13' : 'M0 1h20M0 7h20M0 13h20'} />
      </svg>
    </button>
  </div>
  <div class="menu" id="phone-menu" hidden={!menuOpen}>
    <nav class="nav" aria-label={t('nav.main')}>
      {@render links()}
    </nav>
    <div class="right">
      {@render actions()}
    </div>
  </div>
</header>

<style>
  .hdr {
    border-bottom: 1px solid var(--line);
  }

  .bar {
    display: flex;
    justify-content: space-between;
    align-items: stretch;
  }

  .left,
  .nav {
    display: flex;
    align-items: stretch;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: var(--space-12);
    padding: 0 var(--space-24);
    min-height: 64px;
    border-right: 1px solid var(--line);
  }

  .brand span {
    font-family: var(--pix);
    font-size: 18px;
  }

  .nav a {
    display: flex;
    align-items: center;
    min-height: 64px;
    padding: 0 var(--space-24);
    border-right: 1px solid var(--line);
    font-size: 15px;
    font-weight: 500;
  }

  .nav a:hover,
  .nav a[aria-current='page'] {
    color: var(--pink);
  }

  .right {
    display: flex;
    align-items: center;
    gap: var(--space-16);
    padding: 0 var(--space-16);
  }

  kbd {
    font: 12px var(--mono);
    color: var(--mut);
  }

  .menu-btn {
    display: none;
    align-items: center;
    justify-content: center;
    width: 56px;
    background: transparent;
    border: 0;
    border-left: 1px solid var(--line);
    color: var(--fg);
    cursor: pointer;
  }

  .menu {
    display: none;
  }

  @media (max-width: 760px) {
    .wide {
      display: none;
    }

    .menu-btn {
      display: flex;
    }

    .menu:not([hidden]) {
      display: flex;
      flex-direction: column;
      border-top: 1px solid var(--line);
    }

    .menu .nav {
      flex-direction: column;
    }

    .menu .nav a {
      border-right: 0;
      border-bottom: 1px solid var(--line);
      padding: 0 var(--space-16);
    }

    .menu .right {
      flex-wrap: wrap;
      padding: var(--space-16);
    }

    .brand {
      padding: 0 var(--space-16);
      min-height: 56px;
    }

    .brand span {
      font-size: 16px;
    }
  }
</style>
