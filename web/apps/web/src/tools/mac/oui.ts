import type { Mac } from './mac.ts';

/**
 * Vendor names from a list the visitor loads: the CSV files of the IEEE Registration Authority
 * (`oui.csv` for MA-L, `mam.csv` for MA-M, `oui36.csv` for MA-S). stuffcloud ships none of that data
 * and fetches none of it: the visitor downloads the file and chooses it here, and it is read in this
 * tab only. Pure: no DOM, no I/O.
 */

/** Largest file that is read, in bytes (`oui.csv` is about 4 MB). */
export const MAX_FILE_BYTES = 16 * 1024 * 1024;
/** Most files that are read at once. */
export const MAX_FILES = 8;
/** An organisation name is cut to this many characters. */
export const MAX_NAME_LENGTH = 200;

export type CsvResult =
  | { readonly ok: true; readonly rows: readonly (readonly string[])[] }
  | { readonly ok: false; readonly error: 'unterminated' };

/**
 * RFC 4180: fields separated by commas, quoted with `"` (a quote inside is doubled, and a quoted field
 * may hold commas and line breaks), rows ended by CRLF, LF or CR. A leading byte order mark is dropped.
 */
export function parseCsv(input: string): CsvResult {
  const text = input.startsWith('﻿') ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let started = false;
  for (let at = 0; at < text.length; at += 1) {
    const char = text.charAt(at);
    if (quoted) {
      if (char !== '"') {
        field += char;
      } else if (text.charAt(at + 1) === '"') {
        field += '"';
        at += 1;
      } else {
        quoted = false;
      }
      continue;
    }
    if (char === '"' && field === '') {
      quoted = true;
      started = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
      started = true;
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text.charAt(at + 1) === '\n') {
        at += 1;
      }
      if (started || field !== '') {
        row.push(field);
        rows.push(row);
      }
      row = [];
      field = '';
      started = false;
    } else {
      field += char;
      started = true;
    }
  }
  if (quoted) {
    return { ok: false, error: 'unterminated' };
  }
  if (started || field !== '') {
    row.push(field);
    rows.push(row);
  }
  return { ok: true, rows };
}

export type OuiErrorCode = 'unterminated' | 'columns' | 'empty';

export type OuiParse =
  | {
      readonly ok: true;
      /** Upper-case hex prefixes of 6 (MA-L), 7 (MA-M) or 9 (MA-S) digits. */
      readonly prefixes: readonly string[];
      /** The organisation of each prefix, in the same order. */
      readonly names: readonly string[];
      /** Rows that were not a usable entry (a prefix of another length, an empty name). */
      readonly skipped: number;
    }
  | { readonly ok: false; readonly error: OuiErrorCode };

const PREFIX = /^(?:[0-9A-F]{6}|[0-9A-F]{7}|[0-9A-F]{9})$/;

function column(header: readonly string[], names: readonly string[]): number {
  return header.findIndex((cell) => names.includes(cell.trim().toLowerCase()));
}

/**
 * Reads one IEEE CSV file: a header with the columns `Assignment` and `Organization Name`, then one
 * row per assignment. Rows with another kind of prefix are counted and left out.
 */
export function parseOui(text: string): OuiParse {
  const csv = parseCsv(text);
  if (!csv.ok) {
    return csv;
  }
  const [header, ...rows] = csv.rows;
  const assignment = header === undefined ? -1 : column(header, ['assignment']);
  const organisation =
    header === undefined ? -1 : column(header, ['organization name', 'organisation name']);
  if (assignment === -1 || organisation === -1) {
    return { ok: false, error: 'columns' };
  }
  const prefixes: string[] = [];
  const names: string[] = [];
  let skipped = 0;
  for (const row of rows) {
    const prefix = (row[assignment] ?? '').trim().toUpperCase();
    const name = (row[organisation] ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
    if (!PREFIX.test(prefix) || name === '') {
      skipped += 1;
      continue;
    }
    prefixes.push(prefix);
    names.push(name);
  }
  if (prefixes.length === 0) {
    return { ok: false, error: 'empty' };
  }
  return { ok: true, prefixes, names, skipped };
}

export type Registry = 'MA-L' | 'MA-M' | 'MA-S';

export interface Vendor {
  readonly name: string;
  /** The assignment that matched, as hex digits. */
  readonly prefix: string;
  readonly registry: Registry;
}

const REGISTRY_OF_LENGTH: Readonly<Record<number, Registry>> = { 6: 'MA-L', 7: 'MA-M', 9: 'MA-S' };

/** The loaded entries, looked up by prefix. */
export class OuiIndex {
  readonly #entries = new Map<string, string>();

  constructor(prefixes: readonly string[], names: readonly string[]) {
    for (const [index, prefix] of prefixes.entries()) {
      this.#entries.set(prefix, names[index] ?? '');
    }
  }

  get size(): number {
    return this.#entries.size;
  }

  /**
   * The vendor of an address, longest assignment first (MA-S before MA-M before MA-L). The group bit
   * is ignored, because the registry lists the OUI with it cleared. A locally administered address has
   * no vendor: its first bytes are not an assignment.
   */
  lookup(mac: Mac): Vendor | undefined {
    const first = mac.bytes[0] ?? 0;
    if ((first & 0x02) !== 0) {
      return undefined;
    }
    const digits = [first & 0xfc, ...mac.bytes.slice(1, 5)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
    for (const length of [9, 7, 6]) {
      const prefix = digits.slice(0, length);
      const name = this.#entries.get(prefix);
      const registry = REGISTRY_OF_LENGTH[length];
      if (name !== undefined && registry !== undefined) {
        return { name, prefix, registry };
      }
    }
    return undefined;
  }
}
