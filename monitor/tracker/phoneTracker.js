// Radar tracking for phone pilots (the Android app shares its screen): the phone posts a screenshot about once a
// second, the server finds the minimap and reads the aircraft's position from it, exactly as the PC companion does
// with its own screen capture, and files it like a companion position report. Image work runs on one worker thread
// (worker.js) so the radio hub never waits; when it's busy, a pilot's older frame is dropped for the newer one.
//
//   POST /api/phone-frame?callsign=DAL123&kind=full   body: image/jpeg (whole screen, ~1280 px wide)
//        -> {ok, minimap: {x, y, w, h} as fractions of the screen} | {ok:false, reason}
//   POST /api/phone-frame?callsign=DAL123&kind=mini   body: image/jpeg (just the minimap, full resolution)
//        -> {ok, position} (and the position goes on the radar) | {ok:false, noMarker?, reason}
const path = require('path');
const express = require('express');
const { Worker } = require('worker_threads');

const MAX_JPEG_BYTES = 3 * 1024 * 1024;
const MIN_INTERVAL_MS = 400; // per pilot: about 2 frames a second at most

function createPhoneTracker({ onPosition, logger = console, workerFile = path.join(__dirname, 'worker.js') } = {}) {
  let worker = null;
  let nextId = 1;
  const waiting = new Map(); // id -> resolve
  const queued = new Map(); // callsign -> {job, resolve} (only the newest frame per pilot)
  let busy = false;

  function start() {
    worker = new Worker(workerFile);
    worker.on('message', ({ id, result }) => {
      const resolve = waiting.get(id);
      waiting.delete(id);
      busy = false;
      if (resolve) resolve(result);
      pump();
    });
    worker.on('error', (err) => logger.error(`[phone-tracker] worker crashed: ${err.message}`));
    worker.on('exit', () => {
      for (const resolve of waiting.values()) resolve({ ok: false, reason: 'tracker restarting' });
      waiting.clear();
      busy = false;
      worker = null;
      setTimeout(start, 1000);
    });
  }

  function pump() {
    if (busy || !worker || !queued.size) return;
    const [callsign, { job, resolve }] = queued.entries().next().value;
    queued.delete(callsign);
    busy = true;
    waiting.set(job.id, resolve);
    worker.postMessage(job, [job.jpeg.buffer]);
  }

  /** Queues a frame; resolves with the worker's answer (or {ok:false} if a newer frame from this pilot replaced it). */
  function submit(callsign, kind, jpegBuf) {
    if (!worker) start();
    return new Promise((resolve) => {
      const old = queued.get(callsign);
      if (old) old.resolve({ ok: false, reason: 'skipped (a newer frame arrived)' });
      const bytes = new Uint8Array(jpegBuf.length);
      bytes.set(jpegBuf);
      queued.set(callsign, { job: { id: nextId++, callsign, kind, jpeg: bytes }, resolve });
      pump();
    });
  }

  const lastAt = new Map();
  const router = express.Router();
  router.post('/', express.raw({ type: ['image/jpeg', 'application/octet-stream'], limit: MAX_JPEG_BYTES }), async (req, res) => {
    const callsign = String(req.query.callsign || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
    const kind = req.query.kind === 'full' ? 'full' : 'mini';
    if (!callsign) return res.status(400).json({ ok: false, reason: 'callsign is required' });
    if (!Buffer.isBuffer(req.body) || req.body.length < 100) return res.status(400).json({ ok: false, reason: 'send a JPEG' });
    const now = Date.now();
    if (now - (lastAt.get(callsign) || 0) < MIN_INTERVAL_MS) return res.status(429).json({ ok: false, reason: 'too fast' });
    lastAt.set(callsign, now);
    if (lastAt.size > 5000) lastAt.clear();
    const result = await submit(callsign, kind, req.body);
    if (result.ok && result.position) onPosition({ callsign, position: result.position });
    res.json(result);
  });

  return { router, submit, stop: () => worker && worker.terminate() };
}

module.exports = { createPhoneTracker };
