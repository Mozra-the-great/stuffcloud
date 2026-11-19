import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  detectCapabilities,
  isCapability,
  isStickerName,
  isToolCategory,
  missingCapabilities,
  STICKER_NAMES,
  TOOL_CATEGORIES,
} from '../src/index.ts';

describe('detectCapabilities', () => {
  const full = {
    WebAssembly: { instantiate: () => undefined },
    crypto: { subtle: {} },
    Worker: () => undefined,
  };

  it('finds all three in a full browser', () => {
    expect([...detectCapabilities(full)].toSorted()).toEqual([...CAPABILITIES].toSorted());
  });

  it('finds nothing in an empty scope', () => {
    expect(detectCapabilities({}).size).toBe(0);
  });

  it('reports WebCrypto as missing outside a secure context (crypto without subtle)', () => {
    const found = detectCapabilities({ ...full, crypto: {} });
    expect(found.has('webcrypto')).toBe(false);
    expect(found.has('wasm')).toBe(true);
    expect(detectCapabilities({ ...full, crypto: undefined }).has('webcrypto')).toBe(false);
    expect(detectCapabilities({ ...full, crypto: { subtle: null } }).has('webcrypto')).toBe(false);
  });

  it('needs WebAssembly.instantiate, not just the object', () => {
    expect(detectCapabilities({ ...full, WebAssembly: {} }).has('wasm')).toBe(false);
    expect(detectCapabilities({ ...full, WebAssembly: null }).has('wasm')).toBe(false);
    expect(detectCapabilities({ ...full, WebAssembly: 'x' }).has('wasm')).toBe(false);
  });

  it('needs Worker to be a constructor function', () => {
    expect(detectCapabilities({ ...full, Worker: {} }).has('worker')).toBe(false);
    expect(detectCapabilities({ ...full, Worker: undefined }).has('worker')).toBe(false);
  });

  it('fits the real global scope of this runtime', () => {
    expect(detectCapabilities(globalThis).has('wasm')).toBe(true);
  });
});

describe('missingCapabilities', () => {
  it('lists what is required and not available, in the required order', () => {
    expect(missingCapabilities(['worker', 'wasm', 'webcrypto'], new Set(['wasm']))).toEqual([
      'worker',
      'webcrypto',
    ]);
  });

  it('is empty when everything is there or nothing is required', () => {
    expect(missingCapabilities(['wasm'], new Set(['wasm', 'worker']))).toEqual([]);
    expect(missingCapabilities([], new Set())).toEqual([]);
  });
});

describe('guards', () => {
  it('know their lists and nothing else', () => {
    for (const name of CAPABILITIES) {
      expect(isCapability(name)).toBe(true);
    }
    for (const name of TOOL_CATEGORIES) {
      expect(isToolCategory(name)).toBe(true);
    }
    for (const name of STICKER_NAMES) {
      expect(isStickerName(name)).toBe(true);
    }
    expect(isCapability('gpu')).toBe(false);
    expect(isToolCategory('office')).toBe(false);
    expect(isStickerName('unicorn')).toBe(false);
    expect(isStickerName('constructor')).toBe(false);
  });

  it('list every sticker once', () => {
    expect(new Set(STICKER_NAMES).size).toBe(STICKER_NAMES.length);
  });
});
