import { describe, expect, it } from 'vitest';
import { parseToolId, TOOL_ID_MAX_LENGTH } from '../src/index.ts';

describe('parseToolId', () => {
  it.each(['pdf', 'pdf-merge', 'qr-code', 'sha256', 'a', 'a1-b2-c3'])('accepts %s', (id) => {
    const result = parseToolId(id);
    expect(result).toEqual({ ok: true, value: id });
  });

  it('rejects the empty string', () => {
    expect(parseToolId('')).toEqual({ ok: false, error: 'empty' });
  });

  it('accepts exactly the maximum length', () => {
    const id = 'a'.repeat(TOOL_ID_MAX_LENGTH);
    expect(parseToolId(id)).toEqual({ ok: true, value: id });
  });

  it('rejects one character more than the maximum length', () => {
    const id = 'a'.repeat(TOOL_ID_MAX_LENGTH + 1);
    expect(parseToolId(id)).toEqual({ ok: false, error: 'too-long' });
  });

  it('reports the length before the character set', () => {
    expect(parseToolId('A'.repeat(TOOL_ID_MAX_LENGTH + 1))).toEqual({
      ok: false,
      error: 'too-long',
    });
  });

  it.each([
    'PDF',
    'pdf_merge',
    'pdf merge',
    '-pdf',
    'pdf-',
    'pdf--merge',
    '1pdf',
    'pdf.merge',
    '../etc',
    'pdf/merge',
    'pdf\n',
    'pdf-ü',
    'pdf\u0000',
  ])('rejects %j', (id) => {
    expect(parseToolId(id)).toEqual({ ok: false, error: 'invalid-characters' });
  });
});
