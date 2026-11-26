# Performance budgets and Lighthouse

stuffcloud has to stay fast and light (SPEC 1, 2, 7): the toolbox runs in the visitor's browser, so what
the visitor downloads is the cost. This page is the reference for the budgets, the Lighthouse gate and the
rules for changing either (T-25, [#29](https://github.com/Mozra-the-great/stuffcloud/issues/29)). Both gates
are CI jobs in the `needs` of `build`, so a PR that breaks one cannot merge.

## What is measured

Every size is **gzip at level 9**, in bytes, of the files of a production build (`vite build`, minified,
no source maps counted). That is what a visitor downloads: the Caddyfile has `encode zstd gzip`, and
brotli or zstd only make it smaller. Budgets are written in KiB (1024 bytes); a size exactly at its
budget passes, one byte more fails.

| Budget            | Where it is declared                     | What it covers                                                                                                                                                                                                                                                                                                                                                             |
| ----------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell, `scriptKb` | `web/apps/web/perf-budgets.json`         | JavaScript the first page load fetches: the `<script type="module">` and the `modulepreload` links of `index.html` (the app code, Svelte, kern, the tool registry, both message catalogues)                                                                                                                                                                                |
| Shell, `styleKb`  | `perf-budgets.json`                      | CSS the first page load fetches: the `stylesheet` links of `index.html`                                                                                                                                                                                                                                                                                                    |
| Shell, `fontsKb`  | `perf-budgets.json`                      | The font files that CSS names: the worst case, because the browser fetches only the Unicode subsets a page needs                                                                                                                                                                                                                                                           |
| Tool, `scriptKb`  | `budget` in `src/tools/<id>/manifest.ts` | The tool's own lazy code: its page chunk, every chunk it imports that the first page load did not fetch (the parts tools share, such as the file drop or the select, count for each tool that uses them), and their CSS                                                                                                                                                    |
| Tool, `assetsKb`  | `budget` in the manifest                 | Everything else the tool can download: Web Worker scripts and what a worker loads in turn (the pdf.js engine), and later WASM and models. Found by file name in the chunks above, so it is the **upper bound** of what the tool fetches (the PDF tools share one module that names the page-picture worker, so the merge tool is charged for it though it never starts it) |

`pnpm check-budgets` (in `web/`, after `pnpm perf:build`) prints every number and exits 1 with the files and
the overshoot in bytes when a budget is exceeded. The unit tests run the same check against the real build
(`tests/build-output.test.ts`), so a local `pnpm test` shows it too. The checker and its tests are
`apps/web/scripts/perf-budget.ts` and `tests/perf-budget.test.ts`.

## The numbers (2026-11-26, 28 tools, Vite 8)

Measured on the production build of `main` at the time of T-25; the budget is the measured size plus 15 %,
rounded up to a whole KiB (a budget of 0 stays 0: a tool without a worker that gets one must say so).

| Shell        | Measured (KiB gzip) | Budget (KiB) |
| ------------ | ------------------- | ------------ |
| shell script | 92.20               | 107          |
| shell style  | 8.64                | 10           |
| shell fonts  | 200.20              | 231          |

| Tool           | Script (KiB) | Budget | Assets (KiB) | Budget |
| -------------- | ------------ | ------ | ------------ | ------ |
| base64         | 28.41        | 33     | 2.20         | 3      |
| color          | 17.30        | 20     | 0.00         | 0      |
| cron           | 15.93        | 19     | 0.00         | 0      |
| diff           | 15.12        | 18     | 4.61         | 6      |
| hash           | 16.97        | 20     | 2.83         | 4      |
| json-formatter | 20.31        | 24     | 0.00         | 0      |
| json-yaml-xml  | 33.16        | 39     | 36.54        | 43     |
| jwt            | 13.38        | 16     | 0.00         | 0      |
| lorem          | 17.03        | 20     | 0.00         | 0      |
| mac            | 18.25        | 21     | 1.33         | 2      |
| markdown       | 36.92        | 43     | 15.38        | 18     |
| password       | 10.01        | 12     | 0.00         | 0      |
| pdf-merge      | 12.65        | 16     | 695.55       | 800    |
| pdf-pages      | 16.87        | 22     | 695.55       | 800    |
| pdf-split      | 19.03        | 24     | 695.55       | 800    |
| qr             | 62.92        | 73     | 0.00         | 0      |
| regex          | 12.50        | 15     | 0.94         | 2      |
| sql-formatter  | 18.05        | 21     | 0.00         | 0      |
| subnet         | 19.30        | 23     | 0.00         | 0      |
| textops        | 18.94        | 22     | 2.67         | 4      |
| timestamp      | 11.62        | 14     | 0.00         | 0      |
| unit-converter | 12.18        | 15     | 0.00         | 0      |
| url            | 11.05        | 13     | 0.00         | 0      |
| user-agent     | 10.87        | 13     | 0.00         | 0      |
| uuid           | 16.07        | 19     | 0.00         | 0      |

Before T-25 the manifests carried budgets in minified, uncompressed KiB that nobody checked (for example
`qr` 160, `json-yaml-xml` 150, 50 for most tools); the gzip numbers above replace them. Most tools were
far below their old budget, so the new ones are tight on purpose.

Raised since (reviewed, operator-approved 2026-11-26, stuffcloud SF20): `pdf-merge` to 16 KiB, `pdf-pages` to 22 KiB and
`pdf-split` to 24 KiB (kern 0.14.0 and its `SortableList` and `SelectGrid`, #195). The unit test builds with
`NODE_ENV=test` and is a few hundred bytes to 2 KiB larger than `pnpm perf:build`; the budget has to hold for both, so
a new budget is decided from the larger of the two.

## Changing a budget

A budget goes up only in a reviewed change: the `budget` of the tool manifest, or `perf-budgets.json` for the
shell, with the reason (the library, the feature, the measured numbers) in the PR description. Prefer making
the code smaller or loading it later: a large dependency belongs in a lazy chunk or a worker, not in the
shell. A new tool starts from `pnpm new-tool`, runs `pnpm perf:build && pnpm check-budgets`, and sets its
`budget` to the measured size plus 15 % in the same PR. Dependabot bumps that grow a tool past its budget
fail the job the same way, and are decided the same way.

## Lighthouse

Job `lighthouse` audits the shell (`/`) of the production build with Lighthouse
(`pnpm perf:build && pnpm lighthouse`, Chromium locally through `CHROME_PATH`; the minimums are in
`perf-budgets.json`):

| Category       | Minimum (median of 5 runs) |
| -------------- | -------------------------- |
| Performance    | 95                         |
| Accessibility  | 95                         |
| Best practices | 95                         |

Deterministic by construction:

- **Production build, never the dev server.** `scripts/static-server.ts` serves `dist-perf/` the way the
  Caddyfile serves the app: gzip for text, hashed assets cached for good, index fallback, `no-cache` for the
  rest. `vite preview` sends no compression, which would make Lighthouse's simulated slow 4G measure bytes a
  visitor never downloads. The page is addressed as `localhost`, which browsers treat as a secure origin (a real
  instance has HTTPS).
- **Pinned tools.** Lighthouse is an exact version in `package.json` and the lockfile; CI runs it in the Chromium
  build of the Playwright version of the lockfile (the one the e2e job uses), not in whatever the runner image
  ships.
- **Fixed settings.** Lighthouse's own mobile profile (emulated phone, slow 4G, 4x CPU slowdown) with `simulate`
  throttling, which computes the result from the trace instead of sleeping through it, so the load of the machine
  moves it little. Only the three categories above run. Chrome gets a fresh profile for each run and a
  `--host-resolver-rules` that makes everything but `localhost` unreachable, so the run never depends on the
  network (or on software that injects scripts into pages).
- **Median of five runs per category**, never one run: a single run varies by a few points with the speed of
  the machine. If a run is flaky, the answer is more runs or fixing the cause, **never a lower minimum**; the
  numbers of every run are in the job summary and the HTML report of each run is the artifact `lighthouse-reports`.

The performance score is mostly the first load of the shell (FCP, LCP, total blocking time, layout shift), so
it is what the shell budgets above protect: more JavaScript in the first load costs score directly.

Measured at the time of T-25 (job `lighthouse` of #189, five runs, identical from run to run): performance 99,
accessibility 100, best practices 100. The same build on a development machine scored performance 96; there the
best-practices number was lower only because security software injected a script over plain HTTP, so the CI
runner is the reference.

## Offline use

A service worker for the shell and the tools a visitor has used (SPEC 7, optional) is not part of T-25: it needs a
decision about the script location and about how the privacy test sees the worker's requests first. It is tracked in
[#190](https://github.com/Mozra-the-great/stuffcloud/issues/190). Until then the app works offline only as far as
the browser's HTTP cache keeps the hashed files (they are served `immutable`).
