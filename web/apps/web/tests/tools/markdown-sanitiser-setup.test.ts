import type DOMPurify from 'dompurify';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The sanitiser is built once, on first use, and gives a string even in a browser that has Trusted
 * Types. Both need a fresh copy of the module and a stand-in for DOMPurify, so they live apart from
 * the other sanitiser tests.
 */

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('dompurify');
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, 'trustedTypes');
});

describe('the sanitiser instance', () => {
  it('is created once, however many documents are cleaned', async () => {
    const created = vi.fn();
    vi.doMock('dompurify', async (importOriginal) => {
      const original = await importOriginal<{ default: typeof DOMPurify }>();
      return {
        default: (
          window: Parameters<typeof original.default>[0],
        ): ReturnType<typeof original.default> => {
          created();
          return original.default(window);
        },
      };
    });
    const { sanitiseHtml } = await import('../../src/tools/markdown/render.ts');
    expect(sanitiseHtml('<p>a</p>')).toBe('<p>a</p>');
    expect(sanitiseHtml('<p>b</p>')).toBe('<p>b</p>');
    expect(sanitiseHtml('<a href="#x">c</a>')).toBe('<a>c</a>');
    expect(created).toHaveBeenCalledTimes(1);
  });

  it('does not hand out a Trusted Types object when the browser has Trusted Types', async () => {
    // A trusted type is an object that reads as the HTML it holds.
    const createHTML = vi.fn((html: string): unknown => new String(html));
    Object.defineProperty(window, 'trustedTypes', {
      configurable: true,
      value: {
        createPolicy: (): { createHTML: (html: string) => unknown } => ({ createHTML }),
        emptyHTML: new String(''),
      },
    });
    const { sanitiseHtml } = await import('../../src/tools/markdown/render.ts');
    const result = sanitiseHtml('<p>x</p>');
    expect(typeof result).toBe('string');
    expect(result).toBe('<p>x</p>');
  });
});
