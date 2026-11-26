# Accessibility

The target is WCAG 2.2 level AA (SPEC section 12). Accessibility is checked on every pull
request, not at the end: the checks below are part of the required `build` check, in the job
`e2e` (Playwright, both browsers) and in the unit tests (`pnpm test`). **The gate applies to
every new tool and every new page**; a PR that adds one without its spec does not merge.

## The gate

| What                                           | Where                                                                          | Fails the build when                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| axe in the real browser (Chromium and Firefox) | `web/apps/web/e2e/support/axe.ts`, called by `a11y.check(page, '<state>')`     | any rule of the sets `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa` or `best-practice` is violated, whatever its impact |
| axe on rendered components in jsdom            | `web/apps/web/tests/a11y-components.test.ts`                                   | the same sets, without the rules that need layout (contrast, target size)                                                       |
| keyboard walk                                  | `e2e/support/keyboard.ts` (`expectKeyboardOnly`), `e2e/specs/keyboard.spec.ts` | a control is not reached by Tab in document order, focus is trapped, a focused control shows no ring or is covered              |
| reflow                                         | `e2e/specs/a11y.spec.ts`                                                       | a page needs a horizontal scroll bar at 320 CSS pixels (WCAG 1.4.10)                                                            |
| reduced motion                                 | `e2e/specs/motion.spec.ts`                                                     | anything animates, transitions with a duration or scrolls smoothly while `prefers-reduced-motion: reduce` is set                |

Zero violations is the bar. Nothing is waved through as "minor", and a rule is never switched
off to get green; a real false positive is excluded for that one element with a comment that says
why, in the spec that hits it. The gate can fail: `specs/a11y.spec.ts` ("the gate can fail"),
`specs/keyboard.spec.ts` ("the checks can fail") and the "setting off" tests of `motion.spec.ts`
prove each check against a page that is broken on purpose.

axe finds roughly a third to a half of the possible problems (names, roles, contrast, structure).
What it cannot judge is written down below and is checked by the tests and by review: focus
order and focus after a change, a sensible name, whether a status is announced.

### What a tool's PR must contain

`pnpm new-tool <id>` already creates `e2e/specs/<id>.spec.ts` with two tests: the page opens with
one `h1` and passes axe, and `expectKeyboardOnly` walks it with Tab alone. Extend it:

- Call `a11y.check(page, '<state>')` after **each state** the tool can be in: empty, with a file,
  working, done, failed, cancelled, with the options dialog open, in German.
- Walk every state with the keyboard: choosing a file, starting, cancelling and downloading work
  without a mouse (`expectKeyboardOnly`, plus `page.keyboard.press` for the tool's own keys).
- A result that appears after work (done, failed, a digest, a count) goes into a live region
  (`role="status"`, or `role="alert"` for an error) that exists in the page **before** it has text.
- Progress uses kern's `Progress` with `hideLabel` (`role="progressbar"` named by its label, which is not painted); an indeterminate bar has no value.
- Every control has an accessible name from the message catalogue in both languages; icon-only
  buttons have an `aria-label`; colour is never the only carrier of meaning.
- A decorative picture is `aria-hidden` / `alt=""`; a meaningful one has a text alternative
  (`Mascot` takes `label`). Mascots never speak.
- Touch targets are at least 24 CSS pixels (axe `target-size`, WCAG 2.5.8) and 44 px by design
  on phones (SPEC 12).
- A tool never starts an animation of its own that ignores `prefers-reduced-motion`. The global rule
  in `theme.css` switches CSS animations and transitions off; script-driven motion
  (`requestAnimationFrame`, Web Animations) must check `matchMedia('(prefers-reduced-motion: reduce)')`.

Run it locally from `web/` with `pnpm e2e` (once: `pnpm --filter @stuffcloud/web exec playwright
install chromium firefox`; see `web/apps/web/e2e/README.md`).

## Keyboard map

Everything the app does is reachable with the keyboard alone. No shortcut is a single character
key (WCAG 2.1.4); the one global shortcut uses a modifier.

### Everywhere

| Keys                | Effect                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `Tab` / `Shift+Tab` | Next / previous control, in document order. The first stop on every page is the skip link.                                     |
| `Enter`             | Follows a link, presses a button.                                                                                              |
| `Space`             | Presses a button, toggles a checkbox.                                                                                          |
| `Ctrl+K` / `Cmd+K`  | Opens the tool search (focus goes into the search field).                                                                      |
| `Esc`               | Closes the open dialog and returns focus to the control that opened it; closes the phone menu and returns focus to its button. |

### Page structure

- **Skip link** ("Skip to content"): first Tab stop; `Enter` moves focus to `<main>`.
- **Landmarks**: `header` (banner), `nav` (main navigation, categories), `main`, `footer`
  (contentinfo), the search form (`role="search"`) and the notification region.
- **One `h1` per page**, the page's name; it is also the target of the focus move (below).
- **Header**: brand link, Tools, search button (`Ctrl+K`), language switch. On a phone the links and
  the language switch sit behind the menu button, which is the only header stop.

### Components

| Component                               | Keys                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tabs (`role="tablist"`)                 | One Tab stop (the selected tab). `ArrowRight` / `ArrowLeft` select and focus the next / previous tab and wrap around; `Home` / `End` the first / last. `Tab` leaves the list for the panel.                                                                                                                                                                               |
| Tab links (category navigation)         | Ordinary links: `Tab` between them, `Enter` to follow; the current one has `aria-current="page"`.                                                                                                                                                                                                                                                                         |
| Dialog (native `<dialog>`, modal)       | The page behind is inert. `Tab` and `Shift+Tab` cycle through the dialog; `Esc` or the close button closes it; focus returns to the opener.                                                                                                                                                                                                                               |
| Search dialog                           | Opens with `Ctrl+K`; the search field has focus. Typing filters; `Enter` opens the first hit; `Tab` reaches the hits (links).                                                                                                                                                                                                                                             |
| Language switch                         | Two toggle buttons (`aria-pressed`); `Enter` / `Space` switch at once, focus stays on the button.                                                                                                                                                                                                                                                                         |
| File drop zone                          | The "Choose files" button is the keyboard route (`Enter` / `Space` open the file picker); drag and drop is an extra, never the only way.                                                                                                                                                                                                                                  |
| Toast                                   | A dismiss button per toast; the toast pauses its timer while it is hovered or focused.                                                                                                                                                                                                                                                                                    |
| Page grid (`role="listbox"`, PDF tools) | One Tab stop (the current page). Arrow keys move between pages (Up/Down by a row, `Home`/`End`, `PageUp`/`PageDown`); `Space` or `Enter` selects, `Shift`+arrow or `Shift`+`Space` extends the selection, `Ctrl+A` selects all, `Esc` clears. Where pages can be reordered, `Alt`+arrow moves the focused page; the buttons of the toolbar do the same for the selection. |
| Reorder list (`SortableList`, merge)    | Each item has "up", "down" and "remove" buttons with the item's name; the focus stays on the pressed button (or its partner when it is disabled at the end of the list). Drag and drop is an extra.                                                                                                                                                                       |
| Code block                              | The copy button; its result is announced.                                                                                                                                                                                                                                                                                                                                 |
| Progress bar                            | Not a control; read through its role, name and value.                                                                                                                                                                                                                                                                                                                     |

## Focus management

- **After a navigation** the router moves focus to the new page's `h1` (`tabindex="-1"`), scrolls
  to the top, sets `document.title` and announces "Navigated to ..." in the polite live region.
  Not on the first load (a screen reader reads the page itself) and not on a change of the query
  string only. Wait for the first render before you navigate in a test: a navigation before it
  counts as the first load.
- **Back / forward** do the same.
- **A page that fails to load** is replaced by the error page; its `h1` takes the focus, and
  "Try again" brings the focus to the next page's `h1`.
- **Dialogs** are kern's `Modal`, a native modal `<dialog>`: focus moves in when it opens, the
  background is inert and does not scroll, `Esc` closes, and the browser returns focus to the opener.
- **Menus** (phone menu): the button has `aria-expanded` / `aria-controls`; `Esc` closes and returns
  focus to the button; a navigation closes it.
- **Tool results**: when a tool replaces content the visitor is looking at (an error page, a result
  panel that takes the place of the form), move focus to the new content's heading; when it only
  adds a result next to the controls, announce it in a live region and leave focus where it is.
- **Focus is visible and not covered**: every focusable element shows an outline or ring
  (`theme.css`, `:focus-visible`); sticky or fixed elements never sit on top of the focused one.

## Live regions

Both regions exist, empty, from the first render; text is put into them afterwards (a region that
arrives together with its text is not announced by every screen reader).

| Region                                 | Role                                               | Used for                                                                                                                                                                                                                                          |
| -------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page announcer (kern `LiveAnnouncer`)    | `status`, polite, atomic                           | "Navigated to ..." after each page change; "No connection" / "Connection is back" (`OnlineStatus`)                                                                                                                                                                                                         |
| Toasts                                 | `status` (info, success, warn) and `alert` (error) | Short messages that need no action                                                                                                                                                                                                                |
| Search result count                    | `status`                                           | "3 tools found" / "No tools found" while typing                                                                                                                                                                                                   |
| Tool results                           | `status` or `alert` (the tool's own)               | Done, failed, counts; the PDF tools announce every page action ("Moved 1 page to position 3.") and every undo and redo                                                                                                                            |
| Field errors                           | `alert` (kern's `Field`)                           | Announced once when the error appears. A tool that already says the same message in its own status region (when the visitor leaves the field) passes `announce={false}` to the field, so it is never heard twice (`tests/field-announce.test.ts`) |

## Motion

`prefers-reduced-motion: reduce` switches everything off: `theme.css` sets `animation: none`,
`transition: none` and `scroll-behavior: auto` globally, the mascots show their still pose
(ADR 0008), and the indeterminate progress bar stands still. `e2e/specs/motion.spec.ts` checks
this on every page, on the gallery (every component) and when the setting changes while the page is
open. There is no content that is only available through motion.

## Contrast, size and reflow

- Colours come from the design tokens; `tests/contrast.test.ts` checks the token pairs against
  4.5:1 (text) and 3:1 (UI parts) without a browser, and axe `color-contrast` checks the rendered
  result.
- The text can be enlarged: layouts use `rem`/`em` and wrap; the reflow test checks 320 CSS pixels.
- The page language is set (`<html lang>` follows the language switch); a phrase in the other
  language carries `lang`.

## Not automated

These are reviewed by hand on a UI change (and noted in the PR): the reading order with a screen
reader (NVDA/VoiceOver) on a new kind of widget, wording of names and error messages, 200 % text
zoom on a dense page, and keyboard use of anything built with canvas or WebAssembly output.
