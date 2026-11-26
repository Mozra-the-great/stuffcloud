/**
 * Browser features a tool needs. A tool lists what it cannot work without; the shell shows a
 * notice instead of the tool when the browser lacks one (see `missingCapabilities`).
 */
export const CAPABILITIES = ['wasm', 'webcrypto', 'worker'] as const;

export type Capability = (typeof CAPABILITIES)[number];

export function isCapability(value: unknown): value is Capability {
  return (CAPABILITIES as readonly unknown[]).includes(value);
}

/** The parts of the global scope that {@link detectCapabilities} looks at (`globalThis` fits). */
export interface CapabilityScope {
  readonly WebAssembly?: unknown;
  readonly crypto?: { readonly subtle?: unknown } | undefined;
  readonly Worker?: unknown;
}

/**
 * The capabilities `scope` offers. WebCrypto is `crypto.subtle`, which browsers hide on pages
 * that are not a secure context (plain `http://` on a non-local address), so an instance served
 * without TLS reports it as missing instead of failing inside a tool.
 */
export function detectCapabilities(scope: CapabilityScope): ReadonlySet<Capability> {
  const found = new Set<Capability>();
  const wasm = scope.WebAssembly;
  if (
    typeof wasm === 'object' &&
    wasm !== null &&
    typeof (wasm as { readonly instantiate?: unknown }).instantiate === 'function'
  ) {
    found.add('wasm');
  }
  const subtle = scope.crypto?.subtle;
  if (typeof subtle === 'object' && subtle !== null) {
    found.add('webcrypto');
  }
  if (typeof scope.Worker === 'function') {
    found.add('worker');
  }
  return found;
}

/** The required capabilities that `available` lacks, in the order they were required. */
export function missingCapabilities(
  required: readonly Capability[],
  available: ReadonlySet<Capability>,
): readonly Capability[] {
  return required.filter((capability) => !available.has(capability));
}
