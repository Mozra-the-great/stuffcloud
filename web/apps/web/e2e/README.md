# End-to-end tests (Playwright)

Browser tests of the built app in Chromium and Firefox (issue #14, SPEC 14, ADR 0007). CI job:
`e2e` in `.github/workflows/ci.yml`, part of `needs` of `build`.

```sh
# once: the browsers (about 300 MB, cached by Playwright)
pnpm --filter @stuffcloud/web exec playwright install chromium firefox
pnpm e2e                    # from web/: build, start `vite preview`, run both browsers
pnpm --filter @stuffcloud/web e2e -- --project=chromium shell     # one browser, one spec file
pnpm --filter @stuffcloud/web exec playwright show-report         # after a CI-style run
```

## What runs against what

The tests run against `vite build` + `vite preview`, never the dev server, so minified chunks,
hashed assets and lazy routes are what is tested. The build (`pnpm e2e:build`, output `dist-e2e/`)
is the production app with one difference: `e2e/vite.config.ts` swaps `src/app/tool-entries.ts` for
`e2e/app/tool-entries.ts`, which adds to the real tools (`src/tools/*`)

- the sample tool of the registry tests (`tests/fixtures/sample-tool`),
- `worker-lab`: hashes files in a pool of two workers, can start a job that never ends, downloads a report,
- `leaky-tool`: sends file content away four ways (POST, URL, beacon, worker) on purpose.

The test-only tools live in `e2e/app/tools/`, outside `src/tools`, so they are never part of the shipped
app (the source scan of `tests/tool-rules.test.ts` and the design-kit freeze, #121, do not apply to them).
Their texts are in `e2e/app/messages.ts`.

## Rules for every spec

- Import `test` and `expect` from `../support/fixtures.ts`. Two things then happen on their own:
  - **Privacy** (SPEC 14): when the test ends it fails if the page sent anything except a `GET` of
    its own `/assets/...` (no query string) or the page itself, if anything went to another origin,
    if a WebSocket was opened, or if a piece of a file registered with `net.watch(buffer)` is in a URL,
    header or body (raw, hex, base64, base64url, percent-escaped). Workers are recorded too. The rules
    are in `support/network.ts` and tested without a browser in `tests/e2e-support.test.ts`.
  - **Uncaught errors** in the page fail the test.
- `leaky-tool` proves the privacy check can fail (`specs/privacy.spec.ts`, "the check can fail").
  Those tests switch the enforcement off with `test.use({ enforcePrivacy: false })`; nothing else should.
- Call `a11y.check(page, '<state>')` after each state a test puts on screen. The gate is off:
  `support/a11y.ts` runs nothing until T-05 (#13) passes an axe runner to `createA11yGate` in
  `support/fixtures.ts`.
- No fixed sleeps: wait for something the user can see (`expect(...)`, `expect.poll`). No retries
  (`retries: 0`): a test that passes on the second try is a flaky test.
- Screenshots are attached to the report (`attachScreenshot`), never compared with a stored image.
- Files for uploads are generated (`support/files.ts`, deterministic noise), not committed.

## A machine that injects traffic

Security software that injects scripts into the browser (seen with a local antivirus in Firefox) makes
the privacy check fail on requests the app did not send. `E2E_IGNORE_HOSTS=host.example,other.example`
leaves requests to those hosts (and their subdomains) out of the record. Never set it in CI.
