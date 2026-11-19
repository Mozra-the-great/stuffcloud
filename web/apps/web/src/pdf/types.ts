/**
 * The messages between the PDF tools and their workers (ADR 0013). Everything here must survive
 * `postMessage` (structured clone): plain data, `Blob`s and typed arrays.
 */

/** Why a PDF cannot be used. Shown to the visitor as a sentence of the tool. */
export type PdfIssue = 'encrypted' | 'broken' | 'empty' | 'too-large' | 'out-of-memory';

/** A page of a source file, and the turn it gets on top of its own rotation (clockwise degrees). */
export interface PagePick {
  /** Zero-based page number in the source. */
  readonly index: number;
  /** 0, 90, 180 or 270. */
  readonly turn: number;
}

/** Pages of one source file, in the order they appear in the output. */
export interface Part {
  /** Position of the file in `BuildInput.sources`. */
  readonly source: number;
  readonly pages: readonly PagePick[];
}

/** One PDF to create: its name and the parts it is made of, in order. */
export interface OutputSpec {
  readonly name: string;
  readonly parts: readonly Part[];
}

/** Opens a PDF and reports how many pages it has. */
export interface InspectInput {
  readonly kind: 'inspect';
  readonly file: Blob;
}

/** Creates the PDFs of `outputs` from `sources`. */
export interface BuildInput {
  readonly kind: 'build';
  readonly sources: readonly Blob[];
  readonly outputs: readonly OutputSpec[];
  /** Compute the CRC-32 of every output (needed for a ZIP of several files). */
  readonly withChecksums: boolean;
}

export type PdfInput = InspectInput | BuildInput;

export type InspectOutput =
  | {
      readonly kind: 'inspect';
      readonly ok: true;
      readonly pageCount: number;
      /** The rotation each page has in the file (0, 90, 180 or 270). */
      readonly rotations: readonly number[];
    }
  | { readonly kind: 'inspect'; readonly ok: false; readonly issue: PdfIssue };

/** A finished PDF. `crc32` is the checksum the ZIP writer needs, computed where the bytes are. */
export interface BuiltFile {
  readonly name: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly pageCount: number;
  readonly crc32: number;
}

export type BuildOutput =
  | { readonly kind: 'build'; readonly ok: true; readonly files: readonly BuiltFile[] }
  | {
      readonly kind: 'build';
      readonly ok: false;
      readonly issue: PdfIssue;
      /** Which source file the problem is in, when it is one file. */
      readonly source?: number;
    };

export type PdfOutput = InspectOutput | BuildOutput;

/** What the tools need from a worker pool; `WorkerPool` fits, tests bring an in-process runner. */
export interface PdfRunner<I, O> {
  readonly run: (
    input: I,
    options?: {
      readonly signal?: AbortSignal | undefined;
      readonly onProgress?: ((progress: { completed: number; total: number }) => void) | undefined;
      readonly transfer?: object[] | undefined;
    },
  ) => Promise<O>;
  readonly terminate: () => void;
}

/** What the page needs from a rendered thumbnail; an `ImageBitmap` fits. */
export interface ThumbBitmap {
  readonly width: number;
  readonly height: number;
  readonly close: () => void;
}

/** Renders the first-look pictures of some pages of a PDF. */
export interface ThumbInput {
  readonly file: Blob;
  /** Zero-based page numbers. */
  readonly pages: readonly number[];
  /** Width of the pictures in pixels (the pages keep their proportions). */
  readonly width: number;
}

export interface Thumb {
  /** Zero-based page number. */
  readonly page: number;
  readonly bitmap: ThumbBitmap;
}

export type ThumbOutput =
  | { readonly ok: true; readonly thumbs: readonly Thumb[] }
  | { readonly ok: false; readonly issue: PdfIssue };
