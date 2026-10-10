// Entry point for a genuine, isolated Node.js process (spawned by main.js
// via child_process.fork() with ELECTRON_RUN_AS_NODE=1) - not run inside
// Electron's main process directly, because tesseract.js's createWorker()
// needs Node's worker_threads.Worker, and Electron's own V8 platform
// initialization doesn't support creating one there either ("The V8
// platform used by this instance of Node does not support creating
// Worker") - moving the call from preload to main wasn't enough, since
// main process V8 has the same limitation. ELECTRON_RUN_AS_NODE makes
// Electron's own binary behave as a real, unrestricted Node.js process
// instead (Electron's own documented mechanism for exactly this - see
// https://www.electronjs.org/docs/latest/api/environment-variables#electron_run_as_node),
// which does support worker_threads normally, matching plain `node` here.
//
// Talks to main.js over the standard child_process IPC channel
// (process.send/process.on('message')) - one request/response pair per
// OCR call, correlated by `id`.
const { recognizeText, recognizeHeadingText } = require('./ocr');

process.on('message', async ({ id, image, kind }) => {
  try {
    const text = kind === 'heading' ? await recognizeHeadingText(image) : await recognizeText(image);
    process.send({ id, text });
  } catch (err) {
    process.send({ id, error: err.message });
  }
});
