// pdf.js ships its worker as plain JavaScript without declarations. The tests import it for its
// side effect on `globalThis.pdfjsWorker`: in Node pdf.js then parses in the calling thread.
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown;
}
