const TABLE = new DataView(new ArrayBuffer(256 * 4));

for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  TABLE.setUint32(n * 4, c >>> 0, true);
}

/** CRC-32 (IEEE 802.3, the checksum of ZIP and PNG) of `bytes`, continuing from `previous`. */
export function crc32(bytes: Uint8Array, previous = 0): number {
  let crc = ~previous >>> 0;
  for (const byte of bytes) {
    crc = TABLE.getUint32(((crc ^ byte) & 0xff) * 4, true) ^ (crc >>> 8);
  }
  return ~crc >>> 0;
}
