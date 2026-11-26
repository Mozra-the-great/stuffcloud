import { describe, expect, it, vi } from 'vitest';
import {
  MAX_DECODE_FILE_BYTES,
  MAX_FILE_BYTES,
  asText,
  decodeBase64,
  decodedFileName,
  downloadType,
  encodeBytes,
  isMediaType,
  type EncodeOptions,
} from '../../src/tools/base64/codec.ts';
import { formatSize } from '../../src/tools/base64/messages.ts';
import {
  CHUNK_BYTES,
  isInput,
  runTask,
  transfer,
  type Input,
  type Output,
} from '../../src/tools/base64/task.ts';
import { talkToWorkerDetailed } from '../worker-entry.ts';

const plain: EncodeOptions = { urlSafe: false, padding: true, lineLength: 0 };

describe('the limits', () => {
  it('are 48 MiB to encode, 64 MiB to decode and pieces of 3 MiB', () => {
    expect(MAX_FILE_BYTES).toBe(50_331_648);
    expect(MAX_DECODE_FILE_BYTES).toBe(67_108_864);
    expect(CHUNK_BYTES).toBe(3_145_728);
  });
});

describe('encodeBytes against Node', () => {
  it('writes every length from 0 to 40 bytes the way Buffer does, in both alphabets', () => {
    let state = 5;
    for (let length = 0; length <= 40; length += 1) {
      const bytes = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
        bytes[index] = state >>> 24;
      }
      const standard = Buffer.from(bytes).toString('base64');
      const url = standard.replaceAll('+', '-').replaceAll('/', '_');
      expect(encodeBytes(bytes, plain), String(length)).toBe(standard);
      expect(encodeBytes(bytes, { ...plain, padding: false })).toBe(standard.replace(/=+$/, ''));
      expect(encodeBytes(bytes, { ...plain, urlSafe: true })).toBe(url);
      expect(encodeBytes(bytes, { urlSafe: true, padding: false, lineLength: 0 })).toBe(
        url.replace(/=+$/, ''),
      );
    }
  });

  it('writes the characters of both alphabets that differ', () => {
    const bytes = Uint8Array.from([0xfb, 0xff, 0xfe]);
    expect(encodeBytes(bytes, plain)).toBe('+//+');
    expect(encodeBytes(bytes, { ...plain, urlSafe: true })).toBe('-__-');
  });

  it('pads a partial group with one or two = only when asked', () => {
    expect(encodeBytes(Uint8Array.from([1]), plain)).toBe('AQ==');
    expect(encodeBytes(Uint8Array.from([1, 2]), plain)).toBe('AQI=');
    expect(encodeBytes(Uint8Array.from([1]), { ...plain, padding: false })).toBe('AQ');
    expect(encodeBytes(Uint8Array.from([1, 2]), { ...plain, padding: false })).toBe('AQI');
    expect(encodeBytes(Uint8Array.from([1, 2, 3]), plain)).toBe('AQID');
  });

  it('breaks lines after 64 or 76 characters, with no break at the end', () => {
    const bytes = new Uint8Array(100);
    const text = Buffer.from(bytes).toString('base64');
    expect(encodeBytes(bytes, { ...plain, lineLength: 76 })).toBe(
      `${text.slice(0, 76)}\n${text.slice(76)}`,
    );
    expect(encodeBytes(bytes, { ...plain, lineLength: 64 })).toBe(
      `${text.slice(0, 64)}
${text.slice(64, 128)}
${text.slice(128)}`,
    );
    expect(encodeBytes(new Uint8Array(48), { ...plain, lineLength: 64 })).toBe(
      Buffer.from(new Uint8Array(48)).toString('base64'),
    );
  });
});

describe('decodeBase64: where an error is', () => {
  const at = (text: string): unknown => {
    const result = decodeBase64(text);
    return result.ok
      ? undefined
      : [result.error.code, result.error.offset, result.error.line, result.error.column];
  };

  it('counts a line break of any kind once: LF, CR LF and CR', () => {
    expect(at('AAAA!')).toEqual(['invalidChar', 4, 1, 5]);
    expect(at('AAAA\n!')).toEqual(['invalidChar', 5, 2, 1]);
    expect(at('AAAA\r\n!')).toEqual(['invalidChar', 6, 2, 1]);
    expect(at('AAAA\r!')).toEqual(['invalidChar', 5, 2, 1]);
    expect(at('AA\nAA\r\nA\rA!')).toEqual(['invalidChar', 10, 4, 2]);
    expect(at('\n\n\n!')).toEqual(['invalidChar', 3, 4, 1]);
    expect(at('\r\r!')).toEqual(['invalidChar', 2, 3, 1]);
    expect(at('A\r\n\r\n!')).toEqual(['invalidChar', 5, 3, 1]);
    expect(at('AA !')).toEqual(['invalidChar', 3, 1, 4]);
  });

  it('puts the end of the text at the end of its last line', () => {
    expect(at('AAAAA')).toEqual(['badLength', 5, 1, 6]);
    expect(at('AAAAA\n')).toEqual(['badLength', 6, 2, 1]);
    expect(at('AAAA\nA')).toEqual(['badLength', 6, 2, 2]);
    expect(at('')).toEqual(['empty', 0, 1, 1]);
    expect(at('\n\n')).toEqual(['empty', 2, 3, 1]);
  });

  it('names the character at fault only for a character at fault', () => {
    const error = (text: string): Record<string, unknown> => {
      const result = decodeBase64(text);
      if (result.ok) {
        throw new Error(text);
      }
      return { ...result.error };
    };
    expect(error('AAA!')).toMatchObject({ code: 'invalidChar', found: '!' });
    expect(error('AAé')).toMatchObject({ code: 'invalidChar', found: 'é' });
    expect(error('AA😀')).toMatchObject({ code: 'invalidChar', found: '😀' });
    expect(error('A+A-')).toMatchObject({ code: 'mixedAlphabet', found: '-' });
    for (const text of ['', 'AAAAA', 'AA=A', 'A===']) {
      expect('found' in error(text), text).toBe(false);
    }
  });

  it('wants the whole alphabet to be one of the two', () => {
    const code = (text: string): string => {
      const result = decodeBase64(text);
      return result.ok ? 'ok' : result.error.code;
    };
    for (const [first, second] of [
      ['+', '-'],
      ['+', '_'],
      ['/', '-'],
      ['/', '_'],
    ]) {
      expect(code(`A${first}A${second}`), `${first} ${second}`).toBe('mixedAlphabet');
      expect(code(`A${second}A${first}`), `${second} ${first}`).toBe('mixedAlphabet');
    }
    for (const text of ['A+A/', 'A-A_', 'A+A+', 'A_A_', 'A-A-', 'A/A/', 'A-', 'A_', 'A+', 'A/']) {
      expect(code(`${text}AA`), text).not.toBe('mixedAlphabet');
    }
  });

  it('does not take a character past the table for a letter', () => {
    for (const text of ['AA\u0080A', 'AAÿA', 'AAĀA', 'AAāA', 'AAĀA', 'AAſA']) {
      const result = decodeBase64(text);
      expect(result.ok, text).toBe(false);
      expect(result.ok ? '' : result.error.code, text).toBe('invalidChar');
    }
    const edge = decodeBase64('AA\u007fA');
    expect(edge.ok ? '' : edge.error.code).toBe('invalidChar');
  });
});

describe('decodeBase64: a data URI', () => {
  const media = (text: string): unknown => {
    const result = decodeBase64(text);
    return result.ok ? ('mediaType' in result ? result.mediaType : 'none') : result.error.code;
  };

  it('takes the media type, trimmed, and none when there is none', () => {
    expect(media('data:text/plain;base64,QUJD')).toBe('text/plain');
    expect(media('data: image/png ;base64,QUJD')).toBe('image/png');
    expect(media('data:;base64,QUJD')).toBe('none');
    expect(media('data:  ;base64,QUJD')).toBe('none');
    expect(media('QUJD')).toBe('none');
  });

  it('allows white space before it and any case, but nothing else before it', () => {
    expect(media(' \n data:text/plain;base64,QUJD')).toBe('text/plain');
    expect(media('DATA:Text/Plain;BASE64,QUJD')).toBe('Text/Plain');
    expect(media('xdata:text/plain;base64,QUJD')).toBe('invalidChar');
    expect(media('AAAdata:text/plain;base64,QUJD')).toBe('invalidChar');
  });

  it('wants the base64 marker', () => {
    expect(media('data:text/plain,QUJD')).toBe('notBase64DataUri');
    expect(media('data:,QUJD')).toBe('notBase64DataUri');
  });

  it('decodes the text after the comma, not the prefix', () => {
    const result = decodeBase64('data:text/plain;base64,QUJD');
    expect(result.ok && [...result.bytes]).toEqual([65, 66, 67]);
  });

  it('gives the offsets of an error in the whole text, prefix included', () => {
    const result = decodeBase64('data:text/plain;base64,QU!D');
    expect(result.ok ? undefined : [result.error.offset, result.error.column]).toEqual([25, 26]);
  });
});

describe('decodeBase64: the bytes', () => {
  it('decodes every length from 0 to 40 bytes, with and without padding, in both alphabets', () => {
    let state = 11;
    for (let length = 1; length <= 40; length += 1) {
      const bytes = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
        bytes[index] = state >>> 24;
      }
      const standard = Buffer.from(bytes).toString('base64');
      for (const text of [
        standard,
        standard.replace(/=+$/, ''),
        standard.replaceAll('+', '-').replaceAll('/', '_'),
        standard.replace(/(.{7})/g, '$1\n '),
      ]) {
        const result = decodeBase64(text);
        expect(result.ok && [...result.bytes], `${String(length)} ${text}`).toEqual([...bytes]);
      }
    }
  });

  it('refuses padding in the wrong place or in the wrong amount', () => {
    for (const text of ['A=', 'A==', 'AA=', 'AAA==', 'AA=A', 'AAAA=', 'A===', '====', 'AAAA====']) {
      const result = decodeBase64(text);
      expect(result.ok, text).toBe(false);
    }
    for (const text of ['AA==', 'AAA=', 'AA= =', 'AA\n==']) {
      expect(decodeBase64(text).ok, text).toBe(true);
    }
  });
});

describe('asText', () => {
  it('is the text of valid UTF-8 without control characters other than white space', () => {
    expect(asText(new TextEncoder().encode('a\tb\nc\rd e'))).toBe('a\tb\nc\rd e');
    expect(asText(new TextEncoder().encode('ä你😀'))).toBe('ä你😀');
    expect(asText(new Uint8Array(0))).toBe('');
    expect(asText(new TextEncoder().encode('�'))).toBe('�');
  });

  it.each([0, 1, 7, 8, 14, 27, 31])('is nothing when a control character %j is in it', (code) => {
    expect(asText(Uint8Array.from([65, code, 66]))).toBeUndefined();
    expect(asText(Uint8Array.from([code]))).toBeUndefined();
  });

  it.each([9, 10, 11, 12, 13, 32, 127])('allows the character %j', (code) => {
    expect(asText(Uint8Array.from([65, code, 66]))).toBe(`A${String.fromCharCode(code)}B`);
  });

  it('is nothing for bytes that are not UTF-8', () => {
    expect(asText(Uint8Array.from([0xc3]))).toBeUndefined();
    expect(asText(Uint8Array.from([0xff, 0xfe]))).toBeUndefined();
    expect(asText(Uint8Array.from([65, 0x80]))).toBeUndefined();
  });
});

describe('media types', () => {
  it.each([
    'text/plain',
    'text/plain;charset=utf-8',
    'image/svg+xml',
    'application/vnd.api+json',
    'a/b;c=d;e=f',
    'a/b;c="d e"',
    'a/b;c=""',
    'A0/B1',
    'x-y/z_w',
  ])('accepts %s', (text) => {
    expect(isMediaType(text)).toBe(true);
  });

  it.each([
    '',
    'text',
    '/plain',
    'text/',
    ' text/plain',
    'text/plain ',
    'text/plain\n',
    'x text/plain',
    'text/plain x',
    'text/plain;',
    'text/plain;charset',
    'text/plain;charset=',
    'text/plain;=utf-8',
    'text/plain;a=b;',
    'text/plain;a=b c',
    '-a/b',
    'a/-b',
    '_a/b',
    'a b/c',
    'a/b/c',
    'a/b;c="d\ne"',
    'a/b;c="d"e',
    'a/b;c="d',
    'a/b;c=d"',
    'a/b,c',
    'a/b;c=d;e',
  ])('refuses %j', (text) => {
    expect(isMediaType(text)).toBe(false);
  });
});

describe('what a decoded file is saved as', () => {
  it.each([
    ['image/png', 'png'],
    ['image/jpeg', 'jpg'],
    ['image/gif', 'gif'],
    ['image/webp', 'webp'],
    ['image/avif', 'avif'],
    ['application/pdf', 'pdf'],
    ['application/json', 'json'],
    ['application/zip', 'zip'],
    ['text/css', 'css'],
    ['text/csv', 'csv'],
    ['text/plain', 'txt'],
    ['IMAGE/PNG', 'png'],
    ['image/png; charset=binary', 'png'],
    [' image/png ;x=y', 'png'],
  ])('names a file of %s .%s', (type, extension) => {
    expect(decodedFileName(type, false)).toBe(`decoded.${extension}`);
    expect(decodedFileName(type, true)).toBe(`decoded.${extension}`);
  });

  it('falls back to txt for text and bin for anything else, also for a type that runs in a browser', () => {
    for (const type of [undefined, '', 'foo/bar', 'foo', ';x=y', 'image/x-icon']) {
      expect(decodedFileName(type, true), String(type)).toBe('decoded.txt');
      expect(decodedFileName(type, false), String(type)).toBe('decoded.bin');
    }
    for (const type of [
      'text/html',
      'TEXT/HTML',
      'text/xml',
      'text/javascript',
      'application/xhtml+xml',
      'application/xml',
      'application/javascript',
      'image/svg+xml',
      'image/svg+xml;charset=utf-8',
      ' text/html ; charset=utf-8',
    ]) {
      expect(decodedFileName(type, true), type).toBe('decoded.txt');
      expect(decodedFileName(type, false), type).toBe('decoded.bin');
    }
  });

  it('saves data as the type a data URI named, unless a browser would run it', () => {
    expect(downloadType('image/png', false)).toBe('image/png');
    expect(downloadType('Image/PNG; x=y', false)).toBe('Image/PNG; x=y');
    expect(downloadType('foo/bar', true)).toBe('foo/bar');
    for (const type of [
      'text/html',
      'TEXT/HTML',
      'text/html;charset=utf-8',
      ' text/xml',
      'image/svg+xml',
      'application/javascript',
      'application/xhtml+xml',
      'application/xml',
      'text/javascript',
    ]) {
      expect(downloadType(type, true), type).toBe('text/plain');
      expect(downloadType(type, false), type).toBe('application/octet-stream');
    }
    for (const type of [undefined, '', ';x', ' ']) {
      expect(downloadType(type, true)).toBe('text/plain');
      expect(downloadType(type, false)).toBe('application/octet-stream');
    }
  });

  it('runs a browser-run type only when the whole base type is one of them', () => {
    // These only contain such a type: they are not one.
    for (const type of [
      'application/vnd.text/html+x',
      'text/htmlx',
      'xtext/html',
      'text/html-x',
      'image/svg+xmlx',
      'application/xmlx',
      'text/xml2',
    ]) {
      expect(downloadType(type, false), type).toBe(type);
    }
  });
});

describe('formatSize', () => {
  it('counts in thousands up to GB, with one decimal at most from kB on', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(5)).toBe('5 B');
    expect(formatSize(999)).toBe('999 B');
    expect(formatSize(1000)).toBe('1 kB');
    expect(formatSize(1500)).toBe('1.5 kB');
    expect(formatSize(1549)).toBe('1.5 kB');
    expect(formatSize(1551)).toBe('1.6 kB');
    expect(formatSize(999_999)).toBe('1,000 kB');
    expect(formatSize(1_000_000)).toBe('1 MB');
    expect(formatSize(2_500_000)).toBe('2.5 MB');
    expect(formatSize(1_500_000_000)).toBe('1.5 GB');
    expect(formatSize(1e12)).toBe('1,000 GB');
  });
});

describe('the input check of the worker', () => {
  const file = new Blob(['x']);

  it('wants an object with a file and a known operation', () => {
    expect(isInput({ op: 'decode', file })).toBe(true);
    expect(isInput({ op: 'encode', file, options: plain })).toBe(true);
    expect(isInput({ op: 'encode', file, options: plain, mediaType: 'text/plain' })).toBe(true);
    for (const value of [
      undefined,
      null,
      5,
      'x',
      [],
      {},
      { op: 'decode' },
      { op: 'decode', file: 'x' },
    ]) {
      expect(isInput(value)).toBe(false);
    }
    expect(isInput({ op: 'other', file, options: plain })).toBe(false);
    expect(isInput({ file, options: plain })).toBe(false);
  });

  it('wants options with two booleans and a line length of 0, 64 or 76', () => {
    for (const lineLength of [0, 64, 76]) {
      expect(isInput({ op: 'encode', file, options: { ...plain, lineLength } })).toBe(true);
    }
    for (const options of [
      undefined,
      null,
      5,
      {},
      { ...plain, urlSafe: 'yes' },
      { ...plain, urlSafe: 1 },
      { ...plain, padding: 'yes' },
      { ...plain, padding: 0 },
      { ...plain, lineLength: 63 },
      { ...plain, lineLength: '64' },
      { ...plain, lineLength: 77 },
      { ...plain, lineLength: undefined },
      { urlSafe: false, padding: true },
      { urlSafe: false, lineLength: 0 },
      { padding: true, lineLength: 0 },
    ]) {
      expect(isInput({ op: 'encode', file, options }), JSON.stringify(options)).toBe(false);
    }
  });

  it('wants a media type that is one, when there is one', () => {
    for (const mediaType of [5, null, 'text', ' text/plain', '', {}]) {
      expect(isInput({ op: 'encode', file, options: plain, mediaType })).toBe(false);
    }
    expect(isInput({ op: 'encode', file, options: plain, mediaType: undefined })).toBe(true);
  });
});

/** A file that is only a size: its pieces are empty, so a test can check limits without megabytes. */
function emptyFile(size: number, text = ''): Blob {
  return {
    size,
    text: () => Promise.resolve(text),
    slice: () => ({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) }),
  } as unknown as Blob;
}

describe('runTask: the size limits', () => {
  const progress = vi.fn();

  it('decodes a file of exactly the limit and refuses one byte more', async () => {
    await expect(
      runTask({ op: 'decode', file: emptyFile(MAX_DECODE_FILE_BYTES, 'QUJD') }, { progress }),
    ).resolves.toMatchObject({ ok: true, kind: 'decoded' });
    await expect(
      runTask({ op: 'decode', file: emptyFile(MAX_DECODE_FILE_BYTES + 1, 'QUJD') }, { progress }),
    ).rejects.toThrow(new RangeError('the file is too large to decode'));
  });

  it('encodes a file of exactly the limit and refuses one byte more', async () => {
    const options = plain;
    await expect(
      runTask(
        { op: 'encode', file: emptyFile(MAX_FILE_BYTES), options },
        { progress },
        MAX_FILE_BYTES,
      ),
    ).resolves.toMatchObject({ ok: true, kind: 'encoded', size: MAX_FILE_BYTES });
    await expect(
      runTask(
        { op: 'encode', file: emptyFile(MAX_FILE_BYTES + 1), options },
        { progress },
        MAX_FILE_BYTES,
      ),
    ).rejects.toThrow(new RangeError('the file is too large to encode'));
  });
});

describe('runTask: progress and pieces', () => {
  const calls = (): { fn: (done: number, total: number) => void; list: [number, number][] } => {
    const list: [number, number][] = [];
    return { fn: (done, total) => void list.push([done, total]), list };
  };

  it('reports a decode as done once', async () => {
    const { fn, list } = calls();
    await runTask({ op: 'decode', file: new Blob(['QUJD']) }, { progress: fn });
    expect(list).toEqual([[1, 1]]);
    const failed = calls();
    await runTask({ op: 'decode', file: new Blob(['!']) }, { progress: failed.fn });
    expect(failed.list).toEqual([[1, 1]]);
  });

  it('reads a file in pieces and reports each, and the end once more', async () => {
    const piece = 6;
    const { fn, list } = calls();
    const data = Uint8Array.from({ length: 14 }, (_, index) => index * 17);
    const result = await runTask(
      { op: 'encode', file: new Blob([data]), options: plain },
      { progress: fn },
      piece,
    );
    expect(result).toEqual({
      ok: true,
      kind: 'encoded',
      text: Buffer.from(data).toString('base64'),
      size: 14,
    });
    expect(list).toEqual([
      [6, 14],
      [12, 14],
      [14, 14],
      [14, 14],
    ]);
  });

  it('does not read a piece that is not there when the file is a whole number of pieces', async () => {
    const { fn, list } = calls();
    const data = Uint8Array.from({ length: 12 }, (_, index) => index);
    await runTask({ op: 'encode', file: new Blob([data]), options: plain }, { progress: fn }, 6);
    expect(list).toEqual([
      [6, 12],
      [12, 12],
      [12, 12],
    ]);
  });

  it('encodes a file in pieces exactly as in one go, for every length and option', async () => {
    for (let length = 0; length <= 40; length += 1) {
      const data = Uint8Array.from({ length }, (_, index) => (index * 37 + length) & 255);
      for (const options of [
        plain,
        { urlSafe: true, padding: false, lineLength: 0 },
        { urlSafe: false, padding: true, lineLength: 64 },
        { urlSafe: true, padding: true, lineLength: 76 },
      ] as const) {
        const whole = encodeBytes(data, options);
        for (const piece of [3, 6, 9, 30]) {
          const result = await runTask(
            { op: 'encode', file: new Blob([data]), options },
            { progress: () => undefined },
            piece,
          );
          expect(
            result,
            `${String(length)} ${String(piece)} ${JSON.stringify(options)}`,
          ).toMatchObject({ ok: true, text: whole, size: length });
        }
      }
    }
  });

  it('writes a data URI as one standard padded line, whatever the options say', async () => {
    const result = await runTask(
      {
        op: 'encode',
        file: new Blob(['ab']),
        options: { urlSafe: true, padding: false, lineLength: 64 },
        mediaType: 'text/plain',
      },
      { progress: () => undefined },
    );
    expect(result).toMatchObject({ ok: true, text: 'data:text/plain;base64,YWI=' });
  });

  it('hands the decoded buffer over to the page and nothing else', () => {
    const bytes = new Uint8Array(4);
    const decoded: Output = { ok: true, kind: 'decoded', bytes };
    expect(transfer(decoded)).toEqual([bytes.buffer]);
    expect(transfer({ ok: true, kind: 'encoded', text: 'x', size: 1 })).toEqual([]);
    expect(
      transfer({ ok: false, error: { code: 'empty', offset: 0, line: 1, column: 1 } }),
    ).toEqual([]);
  });
});

describe('the worker file', () => {
  it('answers from worker.ts: encode, decode with the buffer moved, and a refusal', async () => {
    const encode: Input = { op: 'encode', file: new Blob(['abc']), options: plain };
    const decode: Input = { op: 'decode', file: new Blob(['QUJD']) };
    const replies = await talkToWorkerDetailed(
      () => import('../../src/tools/base64/worker.ts'),
      [
        { type: 'run', id: 1, input: encode },
        { type: 'run', id: 2, input: decode },
        { type: 'run', id: 3, input: { op: 'nope' } },
      ],
    );
    const byId = (
      id: number,
    ): { message: Record<string, unknown>; transfer: readonly unknown[] | undefined } => {
      const found = replies.find((reply) => {
        const message = reply.message as { id: number; type: string };
        return message.id === id && message.type !== 'progress';
      });
      if (found === undefined) {
        throw new Error(String(id));
      }
      return { message: found.message as Record<string, unknown>, transfer: found.transfer };
    };
    expect(byId(1).message).toEqual({
      type: 'result',
      id: 1,
      output: { ok: true, kind: 'encoded', text: 'YWJj', size: 3 },
    });
    expect(byId(1).transfer).toEqual([]);
    const decoded = byId(2);
    expect((decoded.message['output'] as { kind: string; bytes: Uint8Array }).kind).toBe('decoded');
    expect(decoded.transfer).toHaveLength(1);
    expect(byId(3).message).toEqual({
      type: 'error',
      id: 3,
      message: 'the worker received input it cannot work with',
    });
  });
});
