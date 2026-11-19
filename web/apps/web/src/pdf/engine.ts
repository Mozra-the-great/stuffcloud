import {
  degrees,
  EncryptedPDFError,
  ParseSpeeds,
  PDFArray,
  type PDFContext,
  PDFDict,
  PDFDocument,
  PDFName,
  type PDFObject,
} from 'pdf-lib';
import { crc32 } from './crc32.ts';
import { fitsInputLimit, MAX_TOTAL_PAGES } from './limits.ts';
import { addTurn } from './page-edit.ts';
import type {
  BuildInput,
  BuildOutput,
  BuiltFile,
  InspectOutput,
  OutputSpec,
  PdfIssue,
} from './types.ts';

/**
 * The PDF work, on top of pdf-lib (MIT). It runs in a worker (`ops-worker.ts`) and in unit tests;
 * nothing here touches the DOM. See ADR 0013 for what it keeps and what it drops on purpose.
 */

/** No pauses between objects (the default parses 100 objects per timer tick): this runs in a worker. */
const LOAD_OPTIONS = { parseSpeed: ParseSpeeds.Fastest, updateMetadata: false } as const;

/** Memory errors of the browsers: V8 ("Array buffer allocation failed", "Invalid array length"), SpiderMonkey ("allocation size overflow"). */
const MEMORY_ERROR = /alloc|memory|array length|buffer length/i;

function isMemoryError(error: unknown): boolean {
  return error instanceof RangeError && MEMORY_ERROR.test(error.message);
}

/** The message of anything thrown; errors of another realm (a worker, a frame) are not `instanceof Error` here. */
function messageOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String(error.message);
  }
  return typeof error === 'string' ? error : '';
}

/** What went wrong, as the visitor needs to hear it. */
export function classify(error: unknown): PdfIssue {
  // pdf-lib is compiled to ES5, where `instanceof` fails for its own error classes (a subclass of
  // `Error` loses its prototype): the message ("Input document to `PDFDocument.load` is encrypted")
  // is what is left to recognise it by.
  if (error instanceof EncryptedPDFError || /encrypted/i.test(messageOf(error))) {
    return 'encrypted';
  }
  return isMemoryError(error) ? 'out-of-memory' : 'broken';
}

async function readBytes(blob: Blob): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await blob.arrayBuffer());
}

/** A page rotation as 0, 90, 180 or 270; files in the wild hold odd values (-90, 450, 45). */
export function normalizeRotation(angle: number): number {
  return addTurn(Math.round(angle / 90) * 90, 0);
}

/** Opens a PDF and reports its pages, or why it cannot be used. */
export async function inspectPdf(file: Blob): Promise<InspectOutput> {
  if (!fitsInputLimit(file.size)) {
    return { kind: 'inspect', ok: false, issue: 'too-large' };
  }
  try {
    const document = await PDFDocument.load(await readBytes(file), LOAD_OPTIONS);
    const pages = document.getPages();
    if (pages.length === 0) {
      return { kind: 'inspect', ok: false, issue: 'empty' };
    }
    if (pages.length > MAX_TOTAL_PAGES) {
      return { kind: 'inspect', ok: false, issue: 'too-large' };
    }
    return {
      kind: 'inspect',
      ok: true,
      pageCount: pages.length,
      rotations: pages.map((page) => normalizeRotation(page.getRotation().angle)),
    };
  } catch (error: unknown) {
    return { kind: 'inspect', ok: false, issue: classify(error) };
  }
}

/** Annotation types that are copied: the ones that carry no reference to another page. */
const MARKUP = new Set([
  'Text',
  'FreeText',
  'Line',
  'Square',
  'Circle',
  'Polygon',
  'PolyLine',
  'Highlight',
  'Underline',
  'Squiggly',
  'StrikeOut',
  'Stamp',
  'Caret',
  'Ink',
]);

/** Entries of a markup annotation that point at other pages, other annotations or actions. */
const ANNOTATION_REFERENCES = ['Parent', 'Popup', 'IRT', 'P', 'Dest', 'A', 'AA', 'Next'] as const;

/** The value of `key` when it is an object of type `type`; any other value (files in the wild have them) counts as absent. */
function lookupAs<T extends PDFObject>(
  context: PDFContext,
  holder: PDFDict,
  key: string,
  is: (value: PDFObject | undefined) => value is T,
): T | undefined {
  const value = context.lookup(holder.get(PDFName.of(key)));
  return is(value) ? value : undefined;
}

const isName = (value: PDFObject | undefined): value is PDFName => value instanceof PDFName;
const isDict = (value: PDFObject | undefined): value is PDFDict => value instanceof PDFDict;
const isArray = (value: PDFObject | undefined): value is PDFArray => value instanceof PDFArray;

/**
 * Whether the annotation may be copied; the entries that tie it to the rest of the source are
 * removed from it. `copyPages` follows every reference, so an internal link, a form field (its
 * `Parent` lists the widgets on other pages) or a reply would pull the pages they point at into
 * the new file as unreachable objects: the content of pages the visitor deleted would stay in the
 * output. Only web links and plain markup survive; bookmarks and form fields are not copied
 * (ADR 0013).
 */
function keepAnnotation(context: PDFContext, annotation: PDFDict): boolean {
  const subtype = lookupAs(context, annotation, 'Subtype', isName)?.decodeText();
  if (subtype === 'Link') {
    if (annotation.has(PDFName.of('Dest'))) {
      return false;
    }
    if (annotation.has(PDFName.of('A'))) {
      const action = lookupAs(context, annotation, 'A', isDict);
      if (action === undefined || lookupAs(context, action, 'S', isName)?.decodeText() !== 'URI') {
        return false;
      }
      action.delete(PDFName.of('Next'));
    }
    for (const key of ['Parent', 'P', 'AA']) {
      annotation.delete(PDFName.of(key));
    }
    return true;
  }
  if (subtype === undefined || !MARKUP.has(subtype)) {
    return false;
  }
  for (const key of ANNOTATION_REFERENCES) {
    annotation.delete(PDFName.of(key));
  }
  return true;
}

/** Cuts the ties of one source page to the rest of its document, see {@link keepAnnotation}. */
function isolatePage(document: PDFDocument, index: number): void {
  const { node } = document.getPage(index);
  const { context } = document;
  const annots = lookupAs(context, node, 'Annots', isArray);
  if (annots !== undefined) {
    const kept: PDFObject[] = [];
    for (let at = 0; at < annots.size(); at += 1) {
      const entry = annots.get(at);
      const annotation = context.lookup(entry);
      if (annotation instanceof PDFDict && keepAnnotation(context, annotation)) {
        kept.push(entry);
      }
    }
    if (kept.length > 0) {
      node.set(PDFName.of('Annots'), context.obj(kept));
    } else {
      node.delete(PDFName.of('Annots'));
    }
  }
  // Article beads and page actions refer to other pages and to scripts.
  node.delete(PDFName.of('B'));
  node.delete(PDFName.of('AA'));
}

/** A source that could not be used: the issue and, when it is one file, which one. */
class SourceFailure extends Error {
  readonly issue: PdfIssue;
  readonly source: number;

  constructor(issue: PdfIssue, source: number) {
    super(`PDF problem in source ${String(source)}: ${issue}`);
    this.name = 'SourceFailure';
    this.issue = issue;
    this.source = source;
  }
}

/** Throws a `TypeError` for a part that asks for something no PDF can give (input from a worker message). */
function checkPart(
  spec: OutputSpec,
  source: number,
  pages: readonly { readonly index: number; readonly turn: number }[],
  pageCount: number | undefined,
): void {
  for (const page of pages) {
    if (!Number.isInteger(page.index) || page.index < 0) {
      throw new TypeError(`${spec.name}: ${String(page.index)} is not a page number`);
    }
    if (!Number.isInteger(page.turn) || page.turn < 0 || page.turn > 270 || page.turn % 90 !== 0) {
      throw new TypeError(`${spec.name}: a turn of ${String(page.turn)} degrees is not allowed`);
    }
    if (pageCount !== undefined && page.index >= pageCount) {
      throw new TypeError(
        `${spec.name}: page ${String(page.index + 1)} does not exist in source ${String(source)}`,
      );
    }
  }
}

/** The bytes in a buffer of their own (a view into a larger buffer is copied), so the buffer can be moved. */
export function ownBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const { buffer } = bytes;
  if (
    buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === buffer.byteLength
  ) {
    return new Uint8Array(buffer);
  }
  return bytes.slice();
}

/** The source file with this number, or a `TypeError` for a request that names one that is not there. */
function sourceAt(sources: readonly Blob[], source: number): Blob {
  const blob = sources[source];
  if (blob === undefined) {
    throw new TypeError(`there is no source ${String(source)}`);
  }
  return blob;
}

/**
 * Creates the PDFs of `input.outputs` from `input.sources`. Each output is a new document that
 * receives the pages of its parts (`copyPages` once per part, so fonts and images shared by the
 * pages are written once). A source is loaded when its first page is needed and kept only while
 * consecutive parts use it, so merging many files holds one at a time and splitting one file
 * loads it once.
 */
export async function buildPdfs(
  input: BuildInput,
  progress: (completed: number, total: number) => void,
): Promise<BuildOutput> {
  const used = new Set(input.outputs.flatMap((spec) => spec.parts.map((part) => part.source)));
  let usedBytes = 0;
  for (const source of used) {
    usedBytes += sourceAt(input.sources, source).size;
  }
  if (!fitsInputLimit(usedBytes)) {
    return { kind: 'build', ok: false, issue: 'too-large' };
  }

  const total = input.outputs.reduce((sum, spec) => sum + spec.parts.length + 1, 0);
  let completed = 0;
  let loaded: { readonly source: number; readonly document: PDFDocument } | undefined;
  const files: BuiltFile[] = [];

  const open = async (source: number): Promise<PDFDocument> => {
    if (loaded?.source === source) {
      return loaded.document;
    }
    loaded = undefined;
    const blob = sourceAt(input.sources, source);
    try {
      const document = await PDFDocument.load(await readBytes(blob), LOAD_OPTIONS);
      loaded = { source, document };
      return document;
    } catch (error: unknown) {
      throw new SourceFailure(classify(error), source);
    }
  };

  try {
    for (const spec of input.outputs) {
      const output = await PDFDocument.create({ updateMetadata: false });
      for (const part of spec.parts) {
        const document = await open(part.source);
        checkPart(spec, part.source, part.pages, document.getPageCount());
        const indices = part.pages.map((page) => page.index);
        for (const index of new Set(indices)) {
          isolatePage(document, index);
        }
        const copies = await output.copyPages(document, indices);
        copies.forEach((copy, at) => {
          const turn = part.pages[at]?.turn ?? 0;
          if (turn !== 0) {
            copy.setRotation(degrees(addTurn(normalizeRotation(copy.getRotation().angle), turn)));
          }
          output.addPage(copy);
        });
        completed += 1;
        progress(completed, total);
      }
      const bytes = ownBuffer(await output.save());
      files.push({
        name: spec.name,
        bytes,
        pageCount: output.getPageCount(),
        crc32: input.withChecksums ? crc32(bytes) : 0,
      });
      completed += 1;
      progress(completed, total);
    }
  } catch (error: unknown) {
    if (error instanceof SourceFailure) {
      return { kind: 'build', ok: false, issue: error.issue, source: error.source };
    }
    if (isMemoryError(error)) {
      return { kind: 'build', ok: false, issue: 'out-of-memory' };
    }
    throw error;
  }
  return { kind: 'build', ok: true, files };
}
