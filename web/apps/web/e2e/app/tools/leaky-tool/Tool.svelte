<script lang="ts">
  import ToolFrame from '../../../../src/app/ToolFrame.svelte';
  import Button from '../../../../src/ui/Button.svelte';
  import FileDropzone from '../../../../src/ui/FileDropzone.svelte';

  /** Where the same-origin leaks go; the privacy test aborts these requests. */
  const POST_PATH = '/__leak';
  const GET_PATH = '/assets/leak.js';

  let bytes: ArrayBuffer | undefined = $state();
  let status = $state('waiting for a file');

  async function pick(files: File[]): Promise<void> {
    const file = files[0];
    if (file !== undefined) {
      bytes = await file.arrayBuffer();
      status = 'ready';
    }
  }

  function onfiles(files: File[]): void {
    void pick(files);
  }

  function base64(buffer: ArrayBuffer): string {
    let text = '';
    for (const byte of new Uint8Array(buffer)) {
      text += String.fromCharCode(byte);
    }
    return btoa(text);
  }

  async function viaPost(data: ArrayBuffer): Promise<void> {
    await fetch(POST_PATH, { method: 'POST', body: data }).catch(() => undefined);
  }

  async function viaQuery(data: ArrayBuffer): Promise<void> {
    await fetch(`${GET_PATH}?d=${encodeURIComponent(base64(data))}`).catch(() => undefined);
  }

  function viaBeacon(data: ArrayBuffer): Promise<void> {
    navigator.sendBeacon(POST_PATH, data);
    return Promise.resolve();
  }

  async function viaWorker(data: ArrayBuffer): Promise<void> {
    const worker = new Worker(new URL('./leak-worker.ts', import.meta.url), { type: 'module' });
    await new Promise<void>((resolve) => {
      worker.addEventListener('message', () => {
        resolve();
      });
      worker.postMessage(data.slice(0));
    });
    worker.terminate();
  }

  async function leak(how: (data: ArrayBuffer) => Promise<void>, name: string): Promise<void> {
    if (bytes === undefined) {
      return;
    }
    status = `sending ${name}`;
    await how(bytes);
    status = `sent ${name}`;
  }
</script>

<ToolFrame id="leaky-tool">
  <FileDropzone hint="Drop a file here" buttonLabel="Choose a file" multiple={false} {onfiles} />
  <div class="row">
    <Button variant="ghost" size="compact" onclick={() => void leak(viaPost, 'post')}
      >Leak by POST</Button
    >
    <Button variant="ghost" size="compact" onclick={() => void leak(viaQuery, 'query')}
      >Leak in a URL</Button
    >
    <Button variant="ghost" size="compact" onclick={() => void leak(viaBeacon, 'beacon')}
      >Leak by beacon</Button
    >
    <Button variant="ghost" size="compact" onclick={() => void leak(viaWorker, 'worker')}
      >Leak from a worker</Button
    >
  </div>
  <p data-testid="leak-status">{status}</p>
</ToolFrame>

<style>
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-12);
  }
</style>
