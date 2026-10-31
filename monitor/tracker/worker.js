// Runs on its own thread (worker_threads), so the radio hub never waits on image work. Gets JPEG screenshots from
// phones (phoneTracker.js) and does what the PC companion does with its screen capture: find the minimap on a full
// screenshot, then read the aircraft's position from the minimap (lib/ = the companion's own tracker code).
const { parentPort } = require('worker_threads');
const jpeg = require('jpeg-js');
const { findMinimap, blankButtons } = require('./lib/minimapFinder');
const { fixFromMinimap } = require('./lib/mapFix');
const { createLocator } = require('./lib/featureLocator');
const { createPositionFilter } = require('./lib/positionFilter');
const { pictureToGame } = require('./lib/frames');
const { loadAirports, nearestAirport } = require('./lib/airports');

const locator = createLocator();
const airports = loadAirports();
const pilots = new Map(); // callsign -> {filter, lastAt}
const MAX_MINI_WIDTH = 1100; // like the companion: bigger crops are shrunk first

function pilot(callsign) {
  let p = pilots.get(callsign);
  if (!p) { p = { filter: createPositionFilter() }; pilots.set(callsign, p); }
  p.lastAt = Date.now();
  for (const [k, v] of pilots) if (Date.now() - v.lastAt > 30 * 60 * 1000) pilots.delete(k);
  return p;
}

function decode(buf) {
  const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 256, maxResolutionInMP: 20 });
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.length) };
}

function shrink(image, maxWidth) {
  if (image.width <= maxWidth) return image;
  const s = maxWidth / image.width;
  const w = Math.round(image.width * s), h = Math.round(image.height * s);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(image.height - 1, Math.floor(y / s));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(image.width - 1, Math.floor(x / s));
      const i = (sy * image.width + sx) * 4, o = (y * w + x) * 4;
      out[o] = image.data[i]; out[o + 1] = image.data[i + 1]; out[o + 2] = image.data[i + 2]; out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

async function handle({ callsign, kind, jpeg: buf }) {
  const image = decode(Buffer.from(buf));
  if (kind === 'full') {
    // where is the minimap? answered as fractions of the screenshot, so the phone can crop its full-size screen
    const r = findMinimap(image);
    if (!r) return { ok: false, minimap: null, reason: 'minimap not found - keep PTFS on screen with the minimap open' };
    return { ok: true, minimap: { x: r.x / image.width, y: r.y / image.height, w: r.w / image.width, h: r.h / image.height } };
  }
  // kind === 'mini': the cropped minimap
  const p = pilot(callsign);
  const fix = await fixFromMinimap(blankButtons(shrink(image, MAX_MINI_WIDTH)), { locator });
  if (fix.error) return { ok: false, noMarker: !!fix.noMarker, reason: fix.error };
  const adj = pictureToGame(fix.xNm, fix.yNm);
  const now = Date.now() / 1000;
  const verdict = p.filter.accept(adj.xNm, adj.yNm, fix.score, now);
  if (!verdict.ok) return { ok: false, reason: `fix ${verdict.reason}` };
  const world = { lat: -adj.yNm / 60, lon: adj.xNm / 60 };
  const near = nearestAirport(airports, world);
  return {
    ok: true,
    fix: { score: fix.score, method: fix.method },
    position: {
      distanceNm: Math.round(near.distanceNm * 100) / 100,
      bearingDeg: Math.round(near.bearingDeg * 10) / 10,
      referenceAirport: near.icao,
      // no HUD to read on the server: the heading is the direction of travel along the track
      altitudeFt: null, headingDeg: p.filter.trackDeg() != null ? Math.round(p.filter.trackDeg()) : null,
      fixAgeSec: 0, squawk: null, identing: false,
    },
  };
}

parentPort.on('message', async (job) => {
  let result;
  try { result = await handle(job); } catch (err) { result = { ok: false, reason: `could not read the picture: ${err.message}` }; }
  parentPort.postMessage({ id: job.id, result });
});
