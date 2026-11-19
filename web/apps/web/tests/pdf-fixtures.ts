import {
  degrees,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRef,
  PDFString,
  StandardFonts,
  type PDFObject,
} from 'pdf-lib';

/** Test PDFs made with pdf-lib: small, deterministic, and identifiable page by page. */

export interface FixturePage {
  /** The page is `width` points wide: the width identifies the page in the output. */
  readonly width: number;
  /** Rotation the page has in the file. */
  readonly rotation?: number;
}

export interface FixtureOptions {
  /** Text drawn on every page (so the file has a font and a content stream). */
  readonly text?: string;
}

/** A PDF whose page `n` (zero-based) is `100 + n` points wide, unless `pages` says otherwise. */
export async function makePdf(
  pages: number | readonly FixturePage[],
  options: FixtureOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const specs: readonly FixturePage[] =
    typeof pages === 'number'
      ? Array.from({ length: pages }, (_, n) => ({ width: 100 + n }))
      : pages;
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const spec of specs) {
    const page = document.addPage([spec.width, 200]);
    page.drawText(options.text ?? 'page', { x: 10, y: 100, size: 12, font });
    if (spec.rotation !== undefined) {
      page.setRotation(degrees(spec.rotation));
    }
  }
  const bytes = await document.save({ useObjectStreams: false });
  return new Uint8Array(bytes);
}

/** A PDF whose trailer has an `/Encrypt` entry (what pdf-lib refuses to open). */
export async function makeEncryptedPdf(): Promise<Uint8Array<ArrayBuffer>> {
  const document = await PDFDocument.create();
  document.addPage([100, 100]);
  const encrypt = document.context.register(document.context.obj({ Filter: 'Standard', V: 1 }));
  const text = Buffer.from(await document.save({ useObjectStreams: false })).toString('latin1');
  // pdf-lib does not write an /Encrypt entry itself: put it into the trailer by hand.
  const patched = text.replace(
    /trailer\s*<<\s*/,
    (match) => `${match}/Encrypt ${String(encrypt.objectNumber)} 0 R `,
  );
  return new Uint8Array(Buffer.from(patched, 'latin1'));
}

export function pdfFile(bytes: Uint8Array<ArrayBuffer>, name = 'a.pdf'): File {
  return new File([bytes], name, { type: 'application/pdf' });
}

/** Widths of the pages of a PDF, in order. */
export async function widthsOf(bytes: Uint8Array): Promise<number[]> {
  const document = await PDFDocument.load(bytes);
  return document.getPages().map((page) => Math.round(page.getWidth()));
}

export async function rotationsOf(bytes: Uint8Array): Promise<number[]> {
  const document = await PDFDocument.load(bytes);
  return document.getPages().map((page) => page.getRotation().angle);
}

/** Objects of the PDF that no page tree path reaches: after a build there must be none. */
export async function unreachableObjects(bytes: Uint8Array): Promise<number> {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  const { context } = document;
  const seen = new Set<PDFObject>();
  const stack: PDFObject[] = [context.trailerInfo.Root as PDFRef];
  let reached = 0;
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) {
      continue;
    }
    const object = item instanceof PDFRef ? context.lookup(item) : item;
    if (object === undefined || seen.has(object)) {
      continue;
    }
    seen.add(object);
    if (item instanceof PDFRef) {
      reached += 1;
    }
    const children: unknown[] = [];
    if (object instanceof PDFDict) {
      children.push(...object.values());
    } else if ('dict' in object && object.dict instanceof PDFDict) {
      children.push(...object.dict.values());
    } else if (object instanceof PDFArray) {
      children.push(...object.asArray());
    }
    for (const child of children) {
      stack.push(child as PDFObject);
    }
  }
  return context.enumerateIndirectObjects().length - reached;
}

/**
 * Gives page `index` a link annotation of the given kind and returns the PDF. `dest` links point
 * at page `target`; `uri` links to a web address; `field` makes a form field with widgets on
 * both pages (what pulls other pages in when a copy follows the field's `Parent`).
 */
export async function withAnnotations(
  bytes: Uint8Array,
  index: number,
  target: number,
  kind: 'dest' | 'uri' | 'field' | 'highlight',
): Promise<Uint8Array<ArrayBuffer>> {
  const document = await PDFDocument.load(bytes);
  const { context } = document;
  const page = document.getPage(index);
  const other = document.getPage(target);
  const entries: PDFRef[] = [];
  if (kind === 'dest') {
    entries.push(
      context.register(
        context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [0, 0, 10, 10],
          Dest: [other.ref, 'Fit'],
        }),
      ),
    );
  } else if (kind === 'uri') {
    entries.push(
      context.register(
        context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [0, 0, 10, 10],
          A: { S: 'URI', URI: PDFString.of('https://example.org/') },
        }),
      ),
    );
  } else if (kind === 'highlight') {
    const popup = context.nextRef();
    const highlight = context.register(
      context.obj({
        Type: 'Annot',
        Subtype: 'Highlight',
        Rect: [0, 0, 10, 10],
        QuadPoints: [0, 0, 10, 0, 0, 10, 10, 10],
        Popup: popup,
        P: page.ref,
      }),
    );
    context.assign(
      popup,
      context.obj({ Type: 'Annot', Subtype: 'Popup', Rect: [0, 0, 5, 5], Parent: highlight }),
    );
    entries.push(highlight);
  } else {
    const field = context.obj({ FT: 'Tx', T: 'f', Kids: [] });
    const fieldRef = context.register(field);
    const widget = (owner: typeof page): PDFRef =>
      context.register(
        context.obj({
          Type: 'Annot',
          Subtype: 'Widget',
          Rect: [0, 0, 10, 10],
          Parent: fieldRef,
          P: owner.ref,
        }),
      );
    const mine = widget(page);
    const theirs = widget(other);
    field.set(PDFName.of('Kids'), context.obj([mine, theirs]));
    entries.push(mine);
    other.node.set(PDFName.of('Annots'), context.obj([theirs]));
  }
  page.node.set(PDFName.of('Annots'), context.obj(entries));
  return new Uint8Array(await document.save({ useObjectStreams: false }));
}

/** Every indirect object of the PDF as text (object streams are opened), for "does it contain ..." checks. */
export async function dumpObjects(bytes: Uint8Array): Promise<string> {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  return document.context
    .enumerateIndirectObjects()
    .map(([ref, object]) => `${ref.toString()} ${object.toString()}`)
    .join('\n');
}
