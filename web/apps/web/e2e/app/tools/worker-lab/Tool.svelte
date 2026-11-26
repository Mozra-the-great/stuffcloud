<script lang="ts">
  import { Button, FileDrop, Progress } from '@mozra-the-great/kern';
  import type { WorkerPool } from '@stuffcloud/tools';
  import ToolFrame from '../../../../src/app/ToolFrame.svelte';
  import { createPool } from './pool.ts';
  import type { Digest, Input } from './task.ts';

  type Status = 'idle' | 'working' | 'done' | 'cancelled' | 'failed';

  let pool: WorkerPool<Input, Digest> | undefined;
  let controller: AbortController | undefined;
  let digests: Digest[] = $state([]);
  let status: Status = $state('idle');
  let completed = $state(0);
  let total = $state(0);
  let workers = $state(0);
  let report: string | undefined = $state();

  $effect(() => () => {
    pool?.terminate();
  });

  function start(count: number): AbortSignal {
    pool ??= createPool();
    controller = new AbortController();
    digests = [];
    completed = 0;
    total = count;
    status = 'working';
    report = undefined;
    return controller.signal;
  }

  async function hash(files: File[]): Promise<void> {
    const signal = start(files.length);
    const activePool = pool;
    if (activePool === undefined) {
      return;
    }
    try {
      // Read everything first, then hand all jobs to the pool in one go: with more files than
      // workers the pool always starts every worker and queues the rest.
      const buffers = await Promise.all(files.map((file) => file.arrayBuffer()));
      const jobs = files.map(async (file, index) => {
        const bytes = buffers[index];
        if (bytes === undefined) {
          throw new RangeError('no buffer for the file');
        }
        const digest = await activePool.run(
          { kind: 'digest', name: file.name, bytes },
          { signal, transfer: [bytes] },
        );
        completed += 1;
        return digest;
      });
      digests = (await Promise.all(jobs)).toSorted((a, b) => a.name.localeCompare(b.name));
      status = 'done';
      report = digests.map((d) => `${d.name}\t${String(d.size)}\t${d.sha256}`).join('\n');
    } catch {
      status = signal.aborted ? 'cancelled' : 'failed';
    }
    workers = activePool.workers;
  }

  async function hold(): Promise<void> {
    const signal = start(2);
    const activePool = pool;
    if (activePool === undefined) {
      return;
    }
    try {
      await activePool.run(
        { kind: 'hold' },
        {
          signal,
          onProgress: (progress) => {
            completed = progress.completed;
            total = progress.total;
            workers = activePool.workers;
          },
        },
      );
      status = 'done';
    } catch {
      status = signal.aborted ? 'cancelled' : 'failed';
    }
    workers = activePool.workers;
  }

  function onfiles(files: File[]): void {
    void hash(files);
  }

  function cancel(): void {
    controller?.abort();
  }

  function download(): void {
    if (report === undefined) {
      return;
    }
    const url = URL.createObjectURL(new Blob([report], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'digests.txt';
    link.click();
    URL.revokeObjectURL(url);
  }
</script>

<ToolFrame id="worker-lab">
  <FileDrop
    mode="dispatch"
    multiple
    rejectMessages={false}
    statusLabel=""
    dropLabel="Drop files here"
    buttonLabel="Choose files"
    {onfiles}
  />
  <div class="row">
    <Button variant="secondary" size="sm" onclick={() => void hold()}
      >Start a job that never ends</Button
    >
    <Button variant="secondary" size="sm" disabled={status !== 'working'} onclick={cancel}
      >Cancel</Button
    >
    <Button variant="secondary" size="sm" disabled={report === undefined} onclick={download}
      >Download report</Button
    >
  </div>
  <Progress hideLabel label="Progress" value={completed} max={Math.max(total, 1)} />
  <p data-testid="lab-status" data-status={status}>
    {status} · {completed} of {total} · workers: {workers}
  </p>
  <ul aria-label="Digests">
    {#each digests as digest (digest.name)}
      <li>{digest.name} · {digest.size} bytes · {digest.sha256}</li>
    {/each}
  </ul>
</ToolFrame>

<style>
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-12);
  }
</style>
