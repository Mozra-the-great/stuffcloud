import type {
  BuildOutput,
  InspectOutput,
  OutputSpec,
  PdfInput,
  PdfOutput,
  PdfRunner,
} from './types.ts';

/** The page side of the PDF worker: typed calls that check the kind of the answer. */

export interface CallOptions {
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: ((completed: number, total: number) => void) | undefined;
}

function runOptions(options: CallOptions): {
  signal: AbortSignal | undefined;
  onProgress: (progress: { completed: number; total: number }) => void;
} {
  return {
    signal: options.signal,
    onProgress: (progress) => {
      options.onProgress?.(progress.completed, progress.total);
    },
  };
}

/** Opens `file` in a worker: its page count and rotations, or why it cannot be used. */
export async function inspectFile(
  runner: PdfRunner<PdfInput, PdfOutput>,
  file: Blob,
  options: CallOptions = {},
): Promise<InspectOutput> {
  const output = await runner.run({ kind: 'inspect', file }, runOptions(options));
  if (output.kind !== 'inspect') {
    throw new TypeError('the worker answered an inspect job with something else');
  }
  return output;
}

/** Builds the PDFs of `outputs` from `sources` in a worker. */
export async function buildFiles(
  runner: PdfRunner<PdfInput, PdfOutput>,
  sources: readonly Blob[],
  outputs: readonly OutputSpec[],
  options: CallOptions = {},
): Promise<BuildOutput> {
  const output = await runner.run(
    { kind: 'build', sources, outputs, withChecksums: outputs.length > 1 },
    runOptions(options),
  );
  if (output.kind !== 'build') {
    throw new TypeError('the worker answered a build job with something else');
  }
  return output;
}
