# ADR 0008: Pixel-art animation runtime: CSS transform keyframes with `steps()`

- Status: Accepted
- Date: 2026-11-16 (spike T-02, issue [#10](https://github.com/Mozra-the-great/stuffcloud/issues/10))
- Decided in: [SPEC 12](../SPEC.md#12-design-and-ux) and [16.1](../SPEC.md#16-decisions-on-the-former-open-questions) (art route and licence), measured in this record

## Context

The art route and the licence were decided earlier (SPEC 16.1): original pixel art under
GPL-3.0-or-later, nine mascots and 42 stickers in `docs/design/prototypes`, drawn as ASCII art
and turned into SVG by `docs/design/tools/mascots.py` and `stickers.py`. What was open is how
the app animates it. SPEC 12 said "sprite-sheet or small canvas animations, paused when
off-screen or when the tab is hidden"; issue #10 adds the acceptance criterion "one animated
main mascot prototype runs at 60 fps on a low-end device without layout shift".

What the delivered art and the design reference actually contain:

- Every mascot is **one SVG frame** (a `viewBox` of 12 to 16 by 8 to 12 art pixels,
  `shape-rendering="crispEdges"`, 440 to 739 bytes). There are no sprite sheets and no second
  poses.
- The only motion in the design reference (`stuff.css`, `.bob`) is two poses switched in one
  step: `translateY(0)` and `translateY(-4px)`, 1.2 s per cycle, `steps(1)`, stopped under
  `prefers-reduced-motion`. The easter eggs (a cat walking along the bottom edge, a cloud
  drifting, a penguin sliding) move the same single frame across the page.
- Rules that hold for any runtime: mascots never speak and carry no filler text, art scales by
  whole numbers with `image-rendering: pixelated`, the CSP allows images from the own origin
  only (no `data:` URIs), the UI is dark only and WCAG 2.2 AA.

## Decision

1. **The mascot is an `<img>` of its SVG file, animated by a CSS `transform` keyframe animation
   with `steps(1)` timing** (kern's `Mascot` since ADR 0014, before that `src/ui/Mascot.svelte`; the same two poses and timing
   as the design reference). No canvas, no sprite sheet, no script per frame. Travelling
   easter eggs use the same technique with `translate` keyframes on the same single frame.
2. **Integer scales only.** The component takes `scale` (and `compactScale` for phones,
   `max-width: 760px`) as whole CSS pixels per art pixel; fractions are cut off and anything
   below 1 becomes 1. `width` and `height` attributes and CSS custom properties reserve the
   exact box before the image loads, so there is no layout shift. The design's 256, 160, 150
   and 110 px widths become scales 16, 10, 9 and 6 (`integerScale()` picks the largest whole
   scale for a target width).
3. **Paused when it cannot be seen.** One `IntersectionObserver` per mascot and a
   `visibilitychange` listener set `data-motion` to `running`, `paused` or `still`; CSS maps
   `paused` to `animation-play-state: paused`. Both run on state changes only, never per frame.
   Without `IntersectionObserver` the mascot keeps running.
4. **`prefers-reduced-motion: reduce` shows the still pose,** decided in CSS (`animation: none`)
   so it follows a change of the setting without a reload. `animated={false}` gives the still
   pose to callers that want it.
5. **Decorative by default:** `alt=""` and `aria-hidden="true"`; an optional `label` makes the
   image a named image (for a 404 page where the mascot is the content). The component renders
   no text.
6. **Animations with more than two poses** (not needed by any delivered art) use a sprite strip
   inside a clipping box and animate its `transform` with `steps()` (variant `css-strip`
   below), never `background-position`. The frame art would be added to `docs/design/` (with the
   PDF rebuilt, as for any design change) and the strip built from it.
7. **The benchmark stays in the repository** (`web/apps/web/bench/`, dev server only, never
   part of the build) so a later change of art or runtime can be measured the same way:
   `node bench/run.ts bench|verify|size` (needs a Chrome, `CHROME_PATH`).

## Measurements

Method: `bench/run.ts` starts the Vite dev server and a headless Chrome 157 (Windows 11, the
display runs at about 144 Hz, so `requestAnimationFrame` ticks every 6.9 ms) and talks to it over
the DevTools protocol without any added dependency. Each variant draws the axolotl at scale 16
(256 x 176 px), once alone and 64 times at once (a stress case: a page has one or two
mascots), with no CPU throttling and with a 6x CPU slowdown as a stand-in for a low-end phone.
Per variant two fresh page loads run for 4 s each: an **idle pass** with nothing else on the
main thread, where `Performance.getMetrics` gives the busy share of the main thread
(`TaskDuration`) and the layout and style recalculation counts; and a **sampling pass** with a
`requestAnimationFrame` sampler for frame intervals, a `PerformanceObserver` for layout shifts
and long tasks, and `document.getAnimations()` for what the browser runs. `static` is the
control (the same image, no animation). The two-pose art is the delivered SVG; the sprite
variants build their two-frame sheet from it in memory, so no new art was drawn.

Variants: `css-transform` (chosen), `css-sprite` (`background-position` animation, the classic
technique), `css-strip` (sheet in a clipping box, `transform` animation), `canvas-raf`
(poses rasterised once, redrawn from a `requestAnimationFrame` loop only when the pose
changes) and `canvas-timer` (the same from one `setInterval`). The canvas variants are the best
case: backing store in device pixels, smoothing off, both poses prerendered.

One mascot, 6x CPU slowdown:

| variant | main busy % | style recalcs (4 s) | fps | p95 frame ms | dropped | CLS |
|---|---|---|---|---|---|---|
| static (control) | 1.58 | 0 | 144.5 | 7.1 | 0 | 0 |
| **css-transform** | **1.54** | **3** | **144.7** | **7.1** | **0** | **0** |
| css-sprite | 22.37 | 581 | 143.8 | 7.1 | 0 | 0 |
| css-strip | 1.38 | 3 | 143.8 | 7.1 | 0 | 0 |
| canvas-raf | 18.30 | 0 | 145.2 | 7.1 | 0 | 0 |
| canvas-timer | 1.81 | 0 | 145.0 | 7.1 | 0 | 0 |

64 mascots, 6x CPU slowdown:

| variant | main busy % | style recalcs (4 s) | fps | p95 frame ms | dropped | CLS |
|---|---|---|---|---|---|---|
| static (control) | 1.40 | 1 | 144.0 | 7.1 | 1 | 0 |
| **css-transform** | **2.65** | **3** | **138.5** | **7.3** | **1** | **0** |
| css-sprite | 82.51 | 539 | 135.3 | 12.6 | 2 | 0 |
| css-strip | 4.01 | 4 | 121.6 | 14.0 | 1 | 0 |
| canvas-raf | 32.67 | 0 | 139.4 | 7.1 | 2 | 0 |
| canvas-timer | 3.10 | 1 | 139.8 | 7.1 | 2 | 0 |

64 mascots, no throttling: main busy 0.23 % (static), 0.30 (css-transform), 5.90 (css-sprite),
0.43 (css-strip), 2.26 (canvas-raf), 0.36 (canvas-timer); every variant at 144.7 to 145.3 fps
and 7.1 ms p95. Layout counts stay at 0 to 2 in every variant (the same as the control), layout
shift is 0 everywhere. The complete tables are reproduced by `node bench/run.ts bench`.

Reading the numbers:

- `css-transform` and `css-strip` cost what the control costs: the browser animates a
  composited layer and the main thread has nothing to do (3 style recalculations in 4 s). Frame times at one mascot are those of the
  idle page with no dropped frame.
- `css-sprite` (`background-position`) repaints on the main thread at every display frame:
  about 140 style recalculations per second whatever the 1.2 s cycle, 22 % busy for a single
  mascot at 6x and 83 % for 64. This is the one technique that cannot meet "60 fps on a
  low-end device" with more than a few mascots, and the reason decision 6 forbids it.
- `canvas-raf` keeps the main thread ticking at the display rate (18 % busy for one mascot at
  6x) although it draws twice a second; `canvas-timer` is as cheap as CSS in the main-thread
  counters, but it needs script for every part CSS gives for free: pause when hidden, a
  `matchMedia` listener for reduced motion, device-pixel-ratio and resize handling, and a
  backing store per mascot on top of the two prerendered pose canvases.
- The frames above 14 ms (a few per run, up to 137 ms for `css-strip` at 64 mascots and 6x) are
  start-up work (decoding and rasterising 64 SVG layers on a slowed CPU); the control shows
  the same effect (32 ms). Differences below about 1 to 2 points of busy share or a single
  dropped frame are noise: three repeats of `static`, `css-transform` and `canvas-timer` with
  64 mascots at 6x gave 3.0 to 3.6 %, 2.3 to 2.9 % and 1.9 to 3.6 % busy.
- Code size (minified, gzip, from `node bench/run.ts size`): `Mascot.svelte` with its
  catalogue, pause logic, props and CSS is 5144 bytes (1839 gzip); the benchmark variants
  without any pause or reduced-motion handling are 564 (364) for `css-transform`, 1766 (854)
  for the two sheet variants and 1569 (767) for the canvas variants. The nine SVG files are
  5393 bytes together (1104 gzip), 440 to 739 bytes each, loaded only when a mascot is drawn.
  Size does not decide between the variants; the main-thread behaviour does.

Behaviour of the shipped component in the gallery page (`node bench/run.ts verify`, same
Chrome): all ten animated mascots run one `steps(1)` animation each (`animationTimingFunction`
is `steps(1)`); `layouts` stay at 0 over 2 s; after scrolling to the bottom all ten are paused
(`running: 0`, `runningMascotAnimations: 0`); under emulated `prefers-reduced-motion: reduce`
the page holds 0 mascot animations and the computed timing function falls back to `ease` of
`animation-name: none`; every image is `image-rendering: pixelated` and drawn at a whole-number
width. Unit tests cover the same rules without a browser (state transitions, observer and
listener teardown, integer scale, stylesheet contents), a build test checks that the nine SVGs
are emitted as files and never inlined and that the minified stylesheet still contains the
transform-only keyframes and the reduced-motion rule.

Limits of this evidence: one machine, a desktop GPU path in headless Chrome and a CPU slowdown
instead of a real low-end phone; single runs per cell. The 60 fps criterion is met with a large
margin on that proxy (no dropped frame for one mascot, p95 equal to the display interval); a
check on a real low-end device remains open (see below).

## Consequences

- Positive: the idle animation costs the main thread nothing and needs no script per frame, so
  it cannot cause jank or layout shift next to the heavy tools (PDF, image, WASM work in
  workers) and stays smooth while the main thread is busy.
- Positive: the shipped art is used as it is, one copy in `docs/design`, crisp at every integer
  scale and every pixel ratio because the browser rasterises the SVG at the final size; no
  asset pipeline and no new runtime dependency (the licence gate and THIRD-PARTY files do not
  change).
- Positive: reduced motion, hidden tabs and off-screen pausing are CSS state plus two cheap
  observers, tested without a browser; the benchmark can show regressions later.
- Negative: only discrete poses are possible (that is the pixel-art look the design wants);
  anything smoother needs a different decision. Mascots with several poses need frame art
  that does not exist yet.
- Negative: the benchmark needs a local Chrome and is not part of CI; the browser-level
  assertions (reduced motion, off-screen pausing) are checked by hand with `verify` until the
  Playwright suite exists.
- Negative: the benchmark adds a dev-only directory with its own tests (`bench/`, counted in
  the coverage floor except the process wiring `page.ts` and `run.ts`).

## Open points

- A check on a real low-end phone, and the same two behaviours (reduced motion, pause
  off-screen) as automatic Playwright tests: T-06 ([#14](https://github.com/Mozra-the-great/stuffcloud/issues/14))
  and T-05 ([#13](https://github.com/Mozra-the-great/stuffcloud/issues/13)); the size budget
  per page belongs to T-25 ([#29](https://github.com/Mozra-the-great/stuffcloud/issues/29)).
- The travelling easter eggs, the seasonal hats and the theme button are built where their
  issues land; they must use `transform` animations as decided here and be measured with
  `bench/run.ts` when they add moving layers.
- The indeterminate `Progress` bar from T-01 animates `background-position` with `steps(4)`
  and therefore repaints at every display frame (the same cause as `css-sprite` above; the
  verify run shows about 140 style recalculations per second on the gallery page because of
  it). It is not part of this decision; issue
  [#114](https://github.com/Mozra-the-great/stuffcloud/issues/114) tracked switching it to a
  `transform` animation, done in #124 (the stripes sit on a child one period wider than the bar
  and `translateX` moves it by one period with `steps(4)`; `verify` then shows 2 to 4 style
  recalculations per 2 s on the gallery page instead of about 350).

## Alternatives considered

- **Canvas loop (`requestAnimationFrame`):** what SPEC 12 allowed. 18 to 33 % busy main
  thread at 6x slowdown for an animation that changes twice a second; needs script for pause,
  reduced motion and pixel-ratio handling. Rejected.
- **Canvas with `setInterval` (poses prerendered):** as cheap as CSS in the counters, but more
  code and one backing store per mascot, with no gain for two poses. Rejected; a possible
  fallback if CSS animations ever become a problem.
- **Sprite sheet with `background-position`:** the classic technique and what SPEC 12 meant by
  "sprite-sheet". Repaints on the main thread at every display frame (22 % busy for one mascot
  at 6x, 83 % for 64). Rejected.
- **Sprite strip with `transform`:** matches `css-transform` in the main-thread counters (1.4 %
  busy for one mascot, 4.0 % for 64 at 6x; its frame statistics at 64 mascots were worse in
  that run, 121.6 fps and p95 14 ms, a single run dominated by start-up) and scales to any
  frame count, but needs sheets the art does not have. Kept as the route for animations with
  more than two poses (decision 6).
- **SVG SMIL (`<animate>`) or the Web Animations API:** no gain over declarative CSS
  keyframes for a fixed two-pose loop, and SMIL inside an `<img>` cannot be paused from the
  page. Not measured; rejected on those grounds.
- **Animated GIF/APNG/WebP:** raster formats of the pixel art would replace the single
  source of truth (the ASCII sources and SVGs), cannot be scaled crisply at every ratio or
  paused, and cannot honour reduced motion. Rejected (SPEC 16.1 already dropped PNG and WebP
  sprite sheets).

## Links

- [SPEC 12](../SPEC.md#12-design-and-ux), [16.1](../SPEC.md#16-decisions-on-the-former-open-questions), `docs/design/README.md` ("Mascots and easter eggs", "Sprite sources"), `docs/design/prototypes/stuff.css` (`.bob`)
- Issues [#10](https://github.com/Mozra-the-great/stuffcloud/issues/10) (T-02), [#9](https://github.com/Mozra-the-great/stuffcloud/issues/9) and PR [#112](https://github.com/Mozra-the-great/stuffcloud/pull/112) (T-01, tokens and components), [#13](https://github.com/Mozra-the-great/stuffcloud/issues/13), [#14](https://github.com/Mozra-the-great/stuffcloud/issues/14), [#29](https://github.com/Mozra-the-great/stuffcloud/issues/29)
- [ADR 0004](0004-client-side-tools.md) (heavy work in workers), [ADR 0007](0007-test-strategy.md)
- Code: kern's `Mascot`, `MASCOT_SOURCES` and `BOB_*` (ADR 0014; until then `src/ui/Mascot.svelte`, `mascots.ts`, `motion.ts`), the art URLs in `web/apps/web/src/app/mascots.ts`; benchmark `web/apps/web/bench/`
