# ADR 0012: Tool registry, manifest schema and worker pool

- Status: Accepted
- Date: 2026-11-19
- Decided in: issue [#12](https://github.com/Mozra-the-great/stuffcloud/issues/12) (T-04),
  PR [#128](https://github.com/Mozra-the-great/stuffcloud/pull/128),
  [SPEC 7](../SPEC.md#7-toolbox)
- Supersedes: nothing. It fills in the "module with a manifest" of
  [ADR 0004](0004-client-side-tools.md) and the `ToolEntry` seam left by
  [ADR 0011](0011-spa-routing-and-i18n.md).

## Context

[ADR 0004](0004-client-side-tools.md) decided that every tool is a first-party module with a
manifest, loaded lazily, doing its heavy work in Web Workers, and that files never leave the
browser. About 25 tools follow in phase 1 (PDF, images, converters, network helpers,
generators). Each one needs the same wiring: a route, a navigation entry, a search entry,
translated texts, a sticker, a size budget and a worker setup. If that wiring is a list somebody
has to remember to extend, tools get forgotten, mis-keyed or half-translated. The privacy
promise must also be something the build can check, not only a sentence in the UI.

## Decision

1. **A tool is a directory.** `web/apps/web/src/tools/<id>/` holds `manifest.ts` (default export:
   the manifest), `Tool.svelte` (the page) and whatever else the tool needs. Nothing else lists
   the tool: the app discovers the manifests with `import.meta.glob` (eager: they are small data;
   the page and its libraries stay behind `load()` and are their own chunk). The id must equal the
   directory name and is the URL (`/tools/<id>`). Tool logic that is independent of the UI may
   live in `packages/tools`, which also holds everything framework-free below.
2. **The manifest** (`ToolManifest` in `@stuffcloud/tools`): `id`, `category` (the SPEC 7
   areas), `nameKey`, `descriptionKey`, `keywordsKey` (message keys, always
   `tool.<id>.name|description|keywords`), `sticker` (one of the design's
   `docs/design/prototypes/sticker-*.svg`), `runsIn` (`client`; `server` exists in the schema and
   is refused), `fileContent`, `requires` (browser capabilities `wasm`, `webcrypto`, `worker`),
   `budget` (`scriptKb`, `assetsKb`) and `load()`. A tool declares **how** it is shown, never the
   text: the texts live in the typed catalogues of ADR 0011, so the missing-key check covers
   them, and `MessageKey` makes a key that does not exist a compile error. The "required libs" and
   "a11y notes" of the SPEC draft are not manifest fields: the libraries are in `package.json` and
   `docs/THIRD-PARTY.md` (checked by the licence gate), accessibility is checked by axe (T-05).
3. **The privacy promise is part of the schema.** `fileContent` must be exactly
   `"stays-in-browser"`; anything else fails the schema, and so does `runsIn: "server"` (a tool
   that needs a server goes through the auth and hosting threat model and a new ADR, not through
   a manifest value). A test scans every source under `src/tools` and `packages/tools/src` for
   network APIs (`fetch`, `XMLHttpRequest`, `sendBeacon`, `WebSocket`, `EventSource`, ...) and
   absolute URLs and fails on any. Loading a WASM or model asset is the first legitimate use of
   `fetch`; it goes through one shared helper added with the first tool that needs it, and that
   helper (not the tool) is the single exception in the scan. The end-to-end proof (no request
   with file content leaves the page while a tool runs) belongs to the Playwright suite (T-06).
4. **One schema, checked three times.** `parseToolManifest` (pure, never throws, reports every
   violated rule with a path, a code and a message; unknown fields are an error, so a typo is
   not ignored) is used by `defineTool` (throws `ManifestError` when the manifest file loads),
   by the registry (`buildRegistry` in `src/app/registry.ts`: all manifests together, ids unique
   and equal to their directory, every text present as plain text in every catalogue,
   `tools.config.json` valid) and by the build: `toolManifestCheck`, a Vite plugin in
   `vite.config.ts`, runs the same registry over `src/tools` in Node when `vite build` or the dev
   server starts and throws, so a bad manifest **fails the build**. `pnpm check-tools` runs the
   check alone. Tests prove each rule on both sides, run the real `vite build` against a broken
   tree and run the script as a plain Node program.
5. **Navigation, search and routing come from the registry.** `buildRegistry` resolves the texts
   for both languages and returns `ToolEntry` values (the seam ADR 0011 left): the tools page,
   the category tabs, the search (id, name and keywords in both languages, not the description),
   and one lazy route per tool. Entries are ordered by category, then id.
6. **`ToolFrame` is every tool page.** `Tool.svelte` renders `<ToolFrame id="...">` around the
   tool's UI. The frame renders the one synchronous `<h1>` ADR 0011 requires, the sticker (decorative),
   the description, the sentence that files stay in this browser, and, instead of the tool, a notice
   naming the capabilities the browser lacks (`detectCapabilities` looks at `WebAssembly`,
   `crypto.subtle`, which browsers hide outside a secure context, and `Worker`). A test fails for a
   `Tool.svelte` that is not a frame or brings its own `<h1>`. The frame is app-specific (it reads the
   registry), so it is not a kern candidate; the sticker image is (marked, #121).
7. **Disabling tools: a build-time configuration file for now.** `web/apps/web/tools.config.json`
   (`{ "disabled": ["<id>"] }`) removes tools from navigation, search and routing (the route
   shows the not-found page). An id that is malformed, listed twice or not a tool is an error, so
   a typo cannot leave a tool enabled. The admin toggle of A-09
   ([#39](https://github.com/Mozra-the-great/stuffcloud/issues/39)) replaces the file with a
   server setting read through the API; until then an operator rebuilds to change the list.
8. **The worker pool** (`createWorkerPool`, `serveWorker` in `@stuffcloud/tools`): a fixed-size
   pool (default: cores minus one, between 1 and 4) that starts workers lazily and keeps a FIFO
   queue. `pool.run(input, { signal, onProgress, transfer })` resolves with the output; progress
   is `{ completed, total }` in units the tool chooses. **Cancelling terminates the worker**: running
   WASM cannot be interrupted, so an aborted job rejects with the signal's reason and its worker is
   stopped and replaced on demand; a queued job is just removed. A thrown handler error rejects only
   that job (`WorkerTaskError`); a dying worker or a message that breaks the protocol rejects the
   running job (`WorkerCrashError`) and the pool starts a fresh worker; `terminate()` rejects everything
   open. The worker side is `serveWorker(handler)` with an optional input guard (what arrives through
   `postMessage` is only typed by trust). The pool takes a `create` factory and a minimal `WorkerLike`
   (the browser's `Worker` fits; a test proves it), so it is tested without a browser.
9. **`pnpm new-tool <id>`** (`web/apps/web/scripts/scaffold.ts`) creates the manifest, the page,
   a test, and the three texts in both catalogues (German starts as the English text and is
   to be translated); `--worker` adds `task.ts` (the work, a pure function), `worker.ts`
   and `pool.ts`; `--category`, `--sticker` and `--name` set the rest. It refuses to overwrite
   anything, checks everything before writing, and formats its output with the repository's
   Prettier configuration. Tests scaffold into a throw-away tree and run the build check on it.

## Consequences

- Positive: adding a tool is adding a directory, and the compiler, the schema, the registry check,
  the catalogue check and the build all object to a half-done tool; the privacy promise cannot be
  dropped silently.
- Positive: the worker pool is generic and tested to the same standard as the Rust core (every
  rule on both sides, schedules fuzzed with a seeded generator, loopback tests with a real
  `serveWorker`), so the PDF and image tools inherit cancellation and progress instead of each
  inventing them.
- Negative: manifests are TypeScript, so checking them in Node relies on Node's type stripping
  (Node 24, as `gen-tokens.ts` already does): manifests may only use erasable TypeScript and
  plain module imports.
- Negative: a disabled tool is still part of the bundle (its chunk is built but never requested);
  tree-shaking disabled tools needs a build-time filter and is not worth it before the admin toggle.
- Negative: cancelling a job costs a worker start (and the data it held) the next time work arrives.
- Negative: the size budgets are declared and range-checked here, but compared with the build
  output only by T-25 ([#29](https://github.com/Mozra-the-great/stuffcloud/issues/29)).

## Open points

- The shared asset loader (WASM and model files from the own origin, with progress) and its single
  exemption in the network scan: with the first tool that needs one (T-10, [#15](https://github.com/Mozra-the-great/stuffcloud/issues/15)).
- Budget enforcement against the build output, per tool: T-25 ([#29](https://github.com/Mozra-the-great/stuffcloud/issues/29)).
- The admin toggle replacing `tools.config.json`: A-09 ([#39](https://github.com/Mozra-the-great/stuffcloud/issues/39)).
- Real-browser coverage of the worker pool and the "no request carries file content" test: T-06
  ([#14](https://github.com/Mozra-the-great/stuffcloud/issues/14)). The pool was run once by hand in
  Chromium against a production build (worker chunk emitted, progress and result delivered, no
  request but the page's own files).

## Alternatives considered

- **A central list (`tools.ts` importing every tool):** rejected. It is the thing people forget to
  extend, and it makes every tool PR touch one shared file.
- **Manifests as JSON or YAML with a JSON Schema:** rejected. The manifest holds a lazy import and
  message keys that the type checker should see; a second format would need its own loader and a
  way to keep the schema and the types in step.
- **A Vite virtual module that generates the registry:** rejected for now. The glob already gives
  one lazy chunk per tool, and the Node-side check gives the build failure without a code generator
  that has to be debugged through the bundler.
- **Configuration fetched at start (`/tools.json`):** rejected. It makes the shell wait for a request
  before it can build its routes and adds a failure mode; the server setting of A-09 will do it properly.
- **Cooperative cancellation (a flag the worker checks):** rejected as the only mechanism. WASM
  routines run to completion; termination is the only cancel that always works. A tool may still
  check its own state between steps.
- **A worker library** (`comlink`, `workerpool`): rejected. The protocol is three message types;
  a dependency would add a licence and supply-chain review for less control over cancellation.
- **Text inside the manifest** (`name: { en, de }`): rejected. It bypasses the catalogues and their
  missing-key, placeholder and plural checks.

## Links

- [SPEC 7](../SPEC.md#7-toolbox), [12](../SPEC.md#12-design-and-ux), [13](../SPEC.md#13-internationalisation-and-privacy), [14](../SPEC.md#14-quality-ci-and-testing)
- Issues [#12](https://github.com/Mozra-the-great/stuffcloud/issues/12) (T-04), [#14](https://github.com/Mozra-the-great/stuffcloud/issues/14) (T-06), [#29](https://github.com/Mozra-the-great/stuffcloud/issues/29) (T-25), [#39](https://github.com/Mozra-the-great/stuffcloud/issues/39) (A-09), [#121](https://github.com/Mozra-the-great/stuffcloud/issues/121) (design kit freeze)
- [ADR 0004](0004-client-side-tools.md), [ADR 0011](0011-spa-routing-and-i18n.md)
