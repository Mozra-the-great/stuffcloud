/**
 * A ZIP archive without compression ("stored"), built from blobs so that no file is copied into
 * memory twice. PDFs are already compressed, so storing them costs nothing and keeps the writer
 * small enough to test completely. The checksums come with the entries: they are computed where the
 * bytes are made (in the worker), not on the page.
 */

export interface ZipEntry {
  /** Path inside the archive, `/`-separated, UTF-8. */
  readonly name: string;
  readonly data: Blob | Uint8Array<ArrayBuffer>;
  /** Length of `data` in bytes. */
  readonly size: number;
  /** CRC-32 of `data`. */
  readonly crc32: number;
}

export class ZipLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipLimitError';
  }
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
/** Version 2.0 needed to extract, the lowest that knows UTF-8 names and "stored" entries. */
const VERSION = 20;
/** General purpose bit 11: the name is UTF-8. */
const UTF8_FLAG = 0x0800;
const MAX_ENTRIES = 0xffff;
/** No ZIP64: offsets, sizes and the archive stay below 4 GiB. */
const MAX_BYTES = 0xffffffff;

/** MS-DOS date and time of `date` in local time (2-second resolution, years 1980 to 2107). */
export function dosDateTime(date: Date): { readonly date: number; readonly time: number } {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  };
}

function writer(length: number): { view: DataView; bytes: Uint8Array<ArrayBuffer> } {
  const buffer = new ArrayBuffer(length);
  return { view: new DataView(buffer), bytes: new Uint8Array(buffer) };
}

/** The archive as one `Blob` (`application/zip`). */
export function buildZip(entries: readonly ZipEntry[], now: Date = new Date()): Blob {
  if (entries.length > MAX_ENTRIES) {
    throw new ZipLimitError(`a ZIP archive holds at most ${String(MAX_ENTRIES)} files`);
  }
  const { date, time } = dosDateTime(now);
  const encoder = new TextEncoder();
  const parts: BlobPart[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    if (entry.size > MAX_BYTES || offset + 30 + name.length + entry.size > MAX_BYTES) {
      throw new ZipLimitError('the archive would be larger than 4 GiB');
    }
    const local = writer(30 + name.length);
    local.view.setUint32(0, LOCAL_HEADER, true);
    local.view.setUint16(4, VERSION, true);
    local.view.setUint16(6, UTF8_FLAG, true);
    // Method 0 (stored) is the zero the buffer starts with.
    local.view.setUint16(10, time, true);
    local.view.setUint16(12, date, true);
    local.view.setUint32(14, entry.crc32, true);
    local.view.setUint32(18, entry.size, true);
    local.view.setUint32(22, entry.size, true);
    local.view.setUint16(26, name.length, true);
    local.bytes.set(name, 30);

    const header = writer(46 + name.length);
    header.view.setUint32(0, CENTRAL_HEADER, true);
    header.view.setUint16(4, VERSION, true);
    header.view.setUint16(6, VERSION, true);
    header.view.setUint16(8, UTF8_FLAG, true);
    header.view.setUint16(12, time, true);
    header.view.setUint16(14, date, true);
    header.view.setUint32(16, entry.crc32, true);
    header.view.setUint32(20, entry.size, true);
    header.view.setUint32(24, entry.size, true);
    header.view.setUint16(28, name.length, true);
    header.view.setUint32(42, offset, true);
    header.bytes.set(name, 46);
    central.push(header.bytes);

    parts.push(local.bytes, entry.data);
    offset += local.bytes.length + entry.size;
  }
  const directorySize = central.reduce((sum, header) => sum + header.length, 0);
  if (offset + directorySize + 22 > MAX_BYTES) {
    throw new ZipLimitError('the archive would be larger than 4 GiB');
  }
  const end = writer(22);
  end.view.setUint32(0, END_OF_CENTRAL_DIRECTORY, true);
  end.view.setUint16(8, entries.length, true);
  end.view.setUint16(10, entries.length, true);
  end.view.setUint32(12, directorySize, true);
  end.view.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.bytes], { type: 'application/zip' });
}
