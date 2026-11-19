# ADR 0013: PDF tools: engines, workers, what a new file keeps, limits

- Status: Accepted
- Date: 2026-11-19
- Decided in: issue [#15](https://github.com/Mozra-the-great/stuffcloud/issues/15) (T-10),
  [SPEC 7](../SPEC.md#7-toolbox)
- Supersedes: nothing. It applies [ADR 0004](0004-client-side-tools.md) (client-side tools, licence
  check per version) and [ADR 0012](0012-tool-registry-and-worker-pool.md) (registry, worker pool)
  to the first real tools.

## Context

T-10 brings the first three real tools: merge PDFs, split a PDF (by ranges, every N pages, or a
selection) and edit the pages of one PDF (rotate, delete, reorder, with undo). Files are private
and large (the acceptance criterion is 100 MB and 500 pages without a frozen page), so the work
has to run off the main thread, to fit in a browser tab, and to say clearly when it cannot. The
output has to be what the visitor sees in the page grid: a page that was deleted must be gone from
the file, not just hidden.

## Decision

1. **Two libraries, each for what it is good at.** `pdf-lib` 1.17.1 (MIT) reads and writes PDFs
   (page count, rotation, copying pages into a new document). `pdfjs-dist` 6.5 (Apache-2.0, the
   `legacy` build, which polyfills the newest JavaScript and runs in Node for the unit tests) draws
   the page pictures. Both licences are GPL-3.0 compatible (SPEC 3). pdf-lib's dependency `tslib`
   (0BSD) is a runtime dependency now, so `0BSD` moves from the build-only list to the allow list of
   `deny.toml` and `scripts/ci/license-policy.toml`; `@napi-rs/canvas`, the Node binding pdf.js lists
   as optional, is removed from the dependency graph with a pnpm override (browsers do not use it,
   the tests bring their own canvas).
2. **Two small pools, not one.** `src/pdf/runners.ts` creates a pool of two workers for opening and
   building (`ops-worker.ts`, pdf-lib) and a pool of two for pictures (`thumbs-worker.ts`, pdf.js).
   Pictures of 500 pages must not make a merge wait, and every worker holds its own copy of the file
   it works on, so both stay small. Both use `createWorkerPool`/`serveWorker` (ADR 0012): progress,
   cancel (the worker is stopped), and the input guard of `serveWorker` (`isPdfInput`,
   `isThumbInput`).
3. **The file goes to the worker, not through the page.** A job carries the `File`/`Blob`; the worker
   reads it (`arrayBuffer()`), so the page never holds 100 MB of bytes. The result comes back as
   transferred buffers and becomes an object URL of this browser; nothing goes over the network
   (the e2e privacy check watches every upload).
4. **pdf.js parses in a nested worker of the app.** pdf.js's own worker file takes the global scope
   of whatever worker imports it as its message port, so it cannot be bundled into `thumbs-worker`
   (our protocol would be answered by pdf.js). The thumbnail worker starts it as a worker of its own
   (`new Worker(new URL('pdfjs-dist/.../pdf.worker.min.mjs', import.meta.url))`, a file in
   `/assets` of the build, same origin, no CDN) and hands it to pdf.js (`PDFWorker`). pdf.js draws on
   an `OffscreenCanvas` supplied through its canvas factory and answers with `ImageBitmap`s, moved
   to the page. A test of the build output pins that both workers and the parser are files of
   `/assets`. pdf.js gets no URL for fonts, CMaps or WASM (see open points).
5. **A result is a new document, built from the pages, not an edit of the old one.** Each output
   is `PDFDocument.create` plus one `copyPages` per source (so fonts and images shared by pages are
   written once). Consequences, each tested:
   - Deleted pages leave nothing behind. `copyPages` follows every reference, so an internal link
     (`/Dest`), a form field (its `/Parent` lists widgets on other pages) or a reply would drag the
     pages they point at into the file as unreachable objects, with their content. Before copying,
     each source page is cut loose: only web links (`/Link` with a `/URI` action) and plain markup
     (highlight, text, ink, stamp, ...; their `/Popup`, `/IRT`, `/P` and actions removed) are kept,
     page actions and article beads are removed. A property test over every subset of pages checks
     that the output has exactly the asked pages and no object that no page reaches.
   - Bookmarks, form fields, internal links, tagged structure and document metadata (title, author,
     dates) are not carried over. The tool descriptions say so for bookmarks and form fields; the
     metadata is dropped on purpose (privacy by default), the producer is not written.
   - Output uses object streams (smaller); the page rotation is `existing + turn`, normalised.
6. **Limits as a memory guard.** All input of one operation: 400 MiB; pages of one document or one
   operation: 10 000; files from one split: 1 000; files in one merge: 200. A file over the limit is
   refused before it is read; an allocation failure inside the worker (`RangeError`) is reported as
   "out of memory". Encrypted files (`/Encrypt`, with or without a password), damaged files and
   files without pages each have their own message that names the file. pdf-lib's errors are compiled
   to ES5 and fail `instanceof`, so the encrypted case is recognised by its message.
7. **Many results leave as a ZIP written here.** A "stored" ZIP (no compression: PDFs do not
   compress) built from `Blob`s in `src/pdf/zip.ts`, with CRC-32 computed in the worker next to the
   bytes. No dependency; no ZIP64 (the limits keep it below 4 GiB, and the writer refuses beyond).
8. **Accessibility.** The page grid is one listbox (one Tab stop, arrow keys, Space/Shift/Ctrl+A,
   Alt+arrow moves the page); every drag and drop has a keyboard route (buttons, "move to position",
   Alt+arrow); every action and every result is announced in a live region that exists from the
   start; actions without a selection are `aria-disabled` (they stay focusable, so the focus is not
   lost when the last undo is pressed) and say what is missing. `ReorderList` and `PageGrid` are
   app-local (kern candidates, #121).

## Consequences

- Positive: a 100 MB PDF with 500 pages merges in about 1 s (11 s for 50 000 small objects) in a
  worker while the page keeps its frames (numbers in the PR); the output contains what the grid
  showed; nothing is uploaded.
- Positive: the engine (`engine.ts`) has no DOM and is tested directly, including against hostile
  structure; workers, pools and components are tested around it.
- Negative: pdf.js and pdf-lib are large (the thumbnail worker with pdf.js is about 1.7 MB, the
  parser worker 1.2 MB, pdf-lib 0.4 MB); they load only when a PDF tool opens and are declared in
  the manifest budgets (checked against the build by T-25, #29).
- Negative: a PDF is parsed into objects, so a job needs a multiple of the file size; the 400 MiB
  limit is a judgement for an ordinary laptop, not a proof.
- Negative: bookmarks and form fields are lost; an "edit in place" mode that keeps them and removes
  the pages properly needs its own garbage collection of unreachable objects.
- Negative: thumbnails of pages that use non-embedded standard fonts or JPEG 2000/JBIG2 images show
  without that text or image (see open points); the pages in the file are unaffected.

## Open points

- Standard font data, CMaps and the WASM decoders of pdf.js for the pictures: they would be served
  from `/assets` through the shared asset loader ADR 0012 announces, and the fonts (Foxit, Liberation)
  and decoders need an entry in `THIRD-PARTY-ASSETS.md` with a licence check first. Not needed for
  the files these tools write.
- Per-page progress inside one large copy: `copyPages` is one call per part; the bar counts parts
  and saves.
- Password protection and metadata editing: T-12 ([#17](https://github.com/Mozra-the-great/stuffcloud/issues/17));
  images to PDF and back: T-11 ([#16](https://github.com/Mozra-the-great/stuffcloud/issues/16)).

## Alternatives considered

- **pdf.js's fake worker inside our worker** (`globalThis.pdfjsWorker`): tried first; pdf.js's worker
  module initialises itself on any worker scope and answers our pool's messages, which crashed the
  pool. The nested worker is the supported route.
- **`@cantoo/pdf-lib`** (maintained fork): not needed for these operations; the SPEC names pdf-lib.
  Revisit with T-12 (encryption).
- **Editing the loaded document in place** (`removePage`, `insertPage`): keeps bookmarks, but the
  removed page objects stay in the file (`save` writes every object of the context), which defeats
  "delete".
- **A ZIP library** (`fflate`, `zip.js`): a dependency and a licence check for 90 lines that are
  tested completely.
- **One pool for everything:** thumbnails would queue in front of the merge.
- **The main thread reading the file** and posting the bytes: a 100 MB `ArrayBuffer` on the page and
  one more copy in flight for every job.

## Links

- [SPEC 7](../SPEC.md#7-toolbox), [14](../SPEC.md#14-quality-ci-and-testing)
- Issues [#15](https://github.com/Mozra-the-great/stuffcloud/issues/15) (T-10),
  [#17](https://github.com/Mozra-the-great/stuffcloud/issues/17) (T-12),
  [#29](https://github.com/Mozra-the-great/stuffcloud/issues/29) (T-25),
  [#121](https://github.com/Mozra-the-great/stuffcloud/issues/121) (design kit freeze)
- [ADR 0004](0004-client-side-tools.md), [ADR 0012](0012-tool-registry-and-worker-pool.md)
