/*
  Its own entry point because a worker is loaded by URL, not imported: `component.js` points
  `GlobalWorkerOptions.workerSrc` at whatever this file compiles to, beside it in /_blocks. The
  rolldown config picks it up from the file name alone -- any `worker.js` next to a block's component
  becomes `<block>.worker.js`.
*/
export * from 'pdfjs-dist/build/pdf.worker.mjs'
