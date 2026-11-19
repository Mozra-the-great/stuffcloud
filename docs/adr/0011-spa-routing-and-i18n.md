# ADR 0011: SPA routing, focus management and internationalisation

- Status: Accepted
- Date: 2026-11-19
- Decided in: issue [#11](https://github.com/Mozra-the-great/stuffcloud/issues/11) (T-03),
  PR [#127](https://github.com/Mozra-the-great/stuffcloud/pull/127),
  [SPEC 7, 12, 13](../SPEC.md#13-internationalisation-and-privacy)
- Supersedes: nothing. It closes the open point "The router for the SPA is not chosen yet" of
  [ADR 0001](0001-stack.md) (see the Addendum there).

## Context

[ADR 0001](0001-stack.md) chose a plain Vite single-page app instead of SvelteKit and left
routing and i18n to T-03. The app shell has to give every tool the same frame: lazy-loaded
routes with deep links, German and English from the start, WCAG 2.2 AA (SPEC 12), no
third-party trackers and a small initial bundle (the budget is set in T-25, #29). The build
output is static files served by Caddy, with no Node runtime. The design freeze of
[#121](https://github.com/Mozra-the-great/stuffcloud/issues/121) allows app-specific pieces
such as the shell but no new generic base components in `src/ui`.

## Decision

1. **Router: a small own router on the History API, no router library.** Path URLs
   (`/tools/merge-pdf`), `pushState`/`popstate`, routes of literal segments and `:name`
   parameters, one global click handler that takes plain same-origin `<a href>` links (so every
   component, including the ones in `src/ui`, just renders a link). Modified clicks, other
   targets, `download`, `rel="external"`, other origins and in-page anchors stay with the
   browser. Code: `web/apps/web/src/app/router/`, about 200 lines, fully unit-tested.
2. **Lazy routes.** Every route is a dynamic `import()`; each page and each tool is its own
   chunk, and a deep link loads the shell plus that one chunk. A tool registers a route
   `/tools/<id>` from its entry (`ToolEntry`: id, category, name per language, `load`); the tool
   registry (T-04) produces these entries. An unknown path, tool id or malformed escape shows
   the not-found page (ghost mascot). A page that fails to load (offline, stale chunk) or to
   render (`<svelte:boundary>`) shows an error state with a retry button; the wording says "no
   connection" when the browser reports being offline.
3. **Deep links need an index fallback.** The server must answer every path that is not an asset
   (and not an API or site path) with `index.html`. The Vite dev and preview servers do this;
   the Caddy site block (F-04, H-19) needs `try_files {path} /index.html` for the app address.
4. **Focus and announcements on navigation.** After a navigation (not on the first load, and not
   when only the query changes) the router outlet moves focus to the page's `<h1>` (or to
   `<main>` when there is none), scrolls to the top, sets `document.title` to
   `<heading> · stuffcloud` and announces `Navigated to <heading>` in a polite live region that
   exists from the start. Every routed page therefore renders exactly one `<h1>` synchronously.
   A skip link is the first tab stop and moves focus to `<main>` without touching the URL.
   While a page loads, the old page stays, `<main>` is `aria-busy`, and a progress bar appears
   only after 150 ms.
5. **i18n: typed message catalogues, no library.** `src/i18n/messages/en.ts` is the source of
   the keys (`MessageKey` is derived from it); `de.ts` is typed `Record<MessageKey, Message>`,
   so a missing or extra key is a compile error. A message is text with `{name}` placeholders
   or plural forms (`one`/`other` and the other CLDR categories) selected with
   `Intl.PluralRules` from `{count}`; numbers in parameters are formatted with
   `Intl.NumberFormat`, and `i18n.number()` and `i18n.date()` format for the current language.
   The language is the stored manual choice, else the first match of `navigator.languages`, else
   English; it is switched at runtime (a reactive Svelte state, no reload), sets `<html lang>`
   and is remembered in `localStorage` (a preference of this browser only, no cookie, nothing is
   sent anywhere). Both catalogues are part of the initial bundle (a few KB); catalogues of
   individual tools can be loaded with the tool later.
6. **CI check.** `tests/i18n-catalogs.test.ts` fails the `web` job when the catalogues differ in
   keys, have an empty or malformed text, differ in placeholders, have plural forms that do not
   match the CLDR categories of the language or do not use `{count}`, when a key is unused, when
   a literal `t('...')` call names a missing key, or when a shell component contains literal
   text or a literal accessible name (the Svelte AST is scanned). The rules are tested against
   deliberately broken catalogues.
7. **Search shortcut.** Ctrl+K / Cmd+K opens the tool search (a modifier combination, so WCAG
   2.1.4 does not apply); the same search opens from a button.
8. **Scope under the design freeze.** The shell is app-specific and composed from `src/ui`
   components. Three pieces are generic and kept app-local under `src/app/`, marked
   "candidate for kern (#121)": the skip link, the live announcer and the offline status.

## Consequences

- Positive: no new runtime dependency (no licence or supply-chain surface); the router and
  i18n are small enough to read and to test completely; the type system turns catalogue
  mistakes into compile errors, the test turns the rest into a CI failure.
- Positive: lazy routes keep the initial JavaScript to the shell; tools cost nothing until
  opened.
- Negative: the project owns routing and i18n code (no nested routes, no route guards, no
  ICU message syntax). Features that need them (the admin area with guards, message formats
  beyond placeholders and plurals) either extend this code or supersede this ADR.
- Negative: path URLs need the index fallback in every deployment (decision 3); a missing
  fallback shows a server 404 on deep links. The CI check for it comes with the Caddy setup.
- Negative: a tool page that fetches its heading asynchronously would not get its title read;
  the rule "one synchronous `<h1>`" has to be kept in review (and in the T-05 axe checks).

## Open points

- The Caddy index fallback is part of F-04 ([#7](https://github.com/Mozra-the-great/stuffcloud/issues/7))
  and H-19 ([#104](https://github.com/Mozra-the-great/stuffcloud/issues/104)); no Caddyfile
  exists yet.
- Initial bundle budget: set and enforced in T-25 ([#29](https://github.com/Mozra-the-great/stuffcloud/issues/29)).
- Keyboard map and automated axe checks of the shell: T-05 ([#13](https://github.com/Mozra-the-great/stuffcloud/issues/13)).

## Alternatives considered

- **A router library** (`svelte-spa-router`, `page.js`, `@mateothegreat/svelte5-router`):
  rejected. Each adds a dependency that needs licence and maintenance review for roughly
  200 lines of logic that must anyway be wrapped for lazy loading, focus management and the
  not-found and error states.
- **Hash routing** (`/#/tools/x`): rejected. It needs no server fallback, but it makes URLs
  ugly, collides with in-page anchors and skip links, and tools may later want fragments.
- **SvelteKit with `adapter-static`:** still not chosen (ADR 0001); the shell needs only
  client-side routing.
- **An i18n library** (`svelte-i18n`, `typesafe-i18n`, `paraglide`): rejected for now. The
  needs are two languages, placeholders, plurals and number/date formatting, all covered by
  `Intl`; the typed catalogue gives the compile-time safety the libraries sell.
- **Catalogues as JSON loaded on demand:** rejected for the shell (an extra request before
  the first paint, no type safety); possible per tool later.
- **Hash or query for the category filter instead of a path:** the filter is `?category=`; a
  separate path would collide with tool ids.

## Links

- [SPEC 7](../SPEC.md#7-toolbox), [12](../SPEC.md#12-design-and-ux), [13](../SPEC.md#13-internationalisation-and-privacy)
- Issues [#11](https://github.com/Mozra-the-great/stuffcloud/issues/11) (T-03), [#121](https://github.com/Mozra-the-great/stuffcloud/issues/121) (design kit freeze)
- [ADR 0001](0001-stack.md), [ADR 0008](0008-pixel-art-animation-runtime.md)
