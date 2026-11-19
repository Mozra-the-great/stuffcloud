import type { TaskContext } from '@stuffcloud/tools';

export interface DigestInput {
  readonly kind: 'digest';
  readonly name: string;
  readonly bytes: ArrayBuffer;
}

/** A job that reports half its progress and then never ends: the page has to cancel it. */
export interface HoldInput {
  readonly kind: 'hold';
}

export type Input = DigestInput | HoldInput;

export interface Digest {
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
}

export function isInput(value: unknown): value is Input {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { kind } = value as { readonly kind?: unknown };
  return (
    kind === 'hold' || (kind === 'digest' && (value as DigestInput).bytes instanceof ArrayBuffer)
  );
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The work of the tool. It runs in the worker, so it must not touch the DOM. */
export async function runTask(input: Input, { progress }: TaskContext): Promise<Digest> {
  if (input.kind === 'hold') {
    progress(1, 2);
    return new Promise<never>(() => undefined);
  }
  const sha256 = hex(await crypto.subtle.digest('SHA-256', input.bytes));
  progress(1, 1);
  return { name: input.name, size: input.bytes.byteLength, sha256 };
}
