import type { TaskContext } from '@stuffcloud/tools';

export interface Input {
  readonly text: string;
}

export type Output = string;

/** The work of the tool. It runs in the worker, so it must not touch the DOM. */
export function runTask(input: Input, { progress }: TaskContext): Output {
  progress(1, 1);
  return input.text;
}
