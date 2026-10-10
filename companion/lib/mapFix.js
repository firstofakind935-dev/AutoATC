// Position fix from the in-game big map. The pilot opens the map; this finds the bright-green aircraft
// marker in a screenshot of it, and works out where on the world the map is looking by matching the
// land/sea shape in the screenshot against the radar's world map (data/worldMask.json) - the map can
// be zoomed and panned, so there is no fixed pixel-to-world conversion to calibrate. Result: a point
// on the radar's own grid (nm, x east, y south), accurate to a few metres at close zoom.
//
// Works on plain {width, height, data} RGBA objects (same shape as canvas ImageData), like marker.js.

const fs = require('fs');
const path = require('path');

// data/ sits two levels up in the repo (companion/lib/) and one level up in the standalone companion app.
const MASK_PATHS = [path.join(__dirname, '..', '..', 'data', 'worldMask.json'), path.join(__dirname, '..', 'data', 'worldMask.json')];
const COARSE = 4; // the coarse search runs on the world mask shrunk by this much

// --- the colours of the game's map -------------------------------------------------------------

const isWater = (r, g, b) => Math.abs(r - 59) < 18 && Math.abs(g - 90) < 18 && Math.abs(b - 125) < 22;
const isTrackLine = (r, g, b) => r > 185 && g > 185 && b > 185 && Math.max(r, g, b) - Math.min(r, g, b) < 40; // white dashes
const isLabel = (r, g, b) => r > 170 && g > 130 && b < 110 && r - b > 80;

// The aircraft marker: a light, bright green (161,233,93 in a real capture), well above the map's own
// darker greens (67,137,68).
function isMarkerGreen(r, g, b) {
  return g >= 190 && g - r >= 45 && g - b >= 90;
}

/**
 * The aircraft marker: the biggest blob of bright green. Returns {x, y, pixelCount} (centre, in the
 * image's own pixels) or null. Blobs are grown with a flood fill so a stray green UI pixel or a
 * second small marker doesn't pull the centre away.
 */
function findMarker(image, { minPixels = 6 } = {}) {
  const { width, height, data } = image;
  const seen = new Uint8Array(width * height);
  let best = null;
  const stack = [];
  for (let start = 0; start < width * height; start++) {
    if (seen[start]) continue;
    const o = start * 4;
    if (!isMarkerGreen(data[o], data[o + 1], data[o + 2])) { seen[start] = 1; continue; }
    let sx = 0, sy = 0, count = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const p = stack.pop();
      const px = p % width, py = (p - px) / width;
      sx += px; sy += py; count += 1;
      // 8-connected, with a one-pixel gap allowed (anti-aliasing breaks the marker into specks)
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = px + dx, ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const q = ny * width + nx;
          if (seen[q]) continue;
          const oq = q * 4;
          if (isMarkerGreen(data[oq], data[oq + 1], data[oq + 2])) { seen[q] = 1; stack.push(q); }
        }
      }
    }
    if (count >= minPixels && (!best || count > best.pixelCount)) best = { x: sx / count, y: sy / count, pixelCount: count };
  }
  return best;
}

// --- land/sea masks ---------------------------------------------------------------------------

/** 1 = land (anything that is not sea, a map label or a white track line), 0 = sea. */
function landMask(image) {
  const { width, height, data } = image;
  const out = new Float32Array(width * height);
  for (let i = 0, o = 0; i < out.length; i++, o += 4) {
    const r = data[o], g = data[o + 1], b = data[o + 2];
    out[i] = isWater(r, g, b) || isTrackLine(r, g, b) || isLabel(r, g, b) ? 0 : 1;
  }
  return { width, height, values: out };
}

let worldMaskCache = null;
function loadWorldMask() {
  if (worldMaskCache) return worldMaskCache;
  const file = MASK_PATHS.find((f) => fs.existsSync(f));
  if (!file) throw new Error('data/worldMask.json is missing');
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const bytes = Buffer.from(json.bits, 'base64');
  const values = new Float32Array(json.width * json.height);
  for (let i = 0; i < values.length; i++) values[i] = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
  worldMaskCache = { width: json.width, height: json.height, pxPerNm: json.pxPerNm, values };
  return worldMaskCache;
}

/** Summed-area table, so any rectangle's average costs four lookups. */
function integral(mask) {
  const { width, height, values } = mask;
  const sat = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += values[y * width + x];
      sat[(y + 1) * (width + 1) + x + 1] = sat[y * (width + 1) + x + 1] + row;
    }
  }
  return { width, height, sat };
}

/** Resamples to outW x outH by averaging the source rectangle each output pixel covers. */
function boxResample(ii, outW, outH) {
  const { width, height, sat } = ii;
  const out = new Float32Array(outW * outH);
  const stride = width + 1;
  for (let y = 0; y < outH; y++) {
    const y0 = Math.floor((y * height) / outH), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / outH));
    for (let x = 0; x < outW; x++) {
      const x0 = Math.floor((x * width) / outW), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / outW));
      const sum = sat[y1 * stride + x1] - sat[y0 * stride + x1] - sat[y1 * stride + x0] + sat[y0 * stride + x0];
      out[y * outW + x] = sum / ((x1 - x0) * (y1 - y0));
    }
  }
  return { width: outW, height: outH, values: out };
}

/** Normalised cross-correlation of `tpl` over every position in `img`. Returns the best {score, x, y}. */
function bestMatch(img, tpl, { xs = null, ys = null } = {}) {
  const tw = tpl.width, th = tpl.height, n = tw * th;
  let tSum = 0, tSq = 0;
  for (let i = 0; i < n; i++) { tSum += tpl.values[i]; tSq += tpl.values[i] * tpl.values[i]; }
  const tMean = tSum / n;
  const tVar = tSq - n * tMean * tMean;
  if (tVar < 1e-6) return { score: -1, x: 0, y: 0 }; // an all-sea or all-land template says nothing
  const iw = img.width;
  // Image window sums via integral images of the values and of their squares.
  const sq = { width: img.width, height: img.height, values: img.values.map((v) => v * v) };
  const s1 = integral(img), s2 = integral(sq);
  const stride = iw + 1;
  const win = (sat, x, y) => sat[(y + th) * stride + x + tw] - sat[y * stride + x + tw] - sat[(y + th) * stride + x] + sat[y * stride + x];
  const xFrom = xs ? Math.max(0, xs[0]) : 0, xTo = xs ? Math.min(img.width - tw, xs[1]) : img.width - tw;
  const yFrom = ys ? Math.max(0, ys[0]) : 0, yTo = ys ? Math.min(img.height - th, ys[1]) : img.height - th;
  let best = { score: -1, x: 0, y: 0 };
  for (let y = yFrom; y <= yTo; y++) {
    for (let x = xFrom; x <= xTo; x++) {
      const wSum = win(s1.sat, x, y), wSq = win(s2.sat, x, y);
      const wVar = wSq - (wSum * wSum) / n;
      if (wVar < 1e-6) continue;
      let dot = 0;
      for (let ty = 0; ty < th; ty++) {
        const ro = (y + ty) * iw + x, to = ty * tw;
        for (let tx = 0; tx < tw; tx++) dot += img.values[ro + tx] * tpl.values[to + tx];
      }
      const score = (dot - (wSum * tSum) / n) / Math.sqrt(wVar * tVar);
      if (score > best.score) best = { score, x, y };
    }
  }
  return best;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Finds where `image` (a screenshot of the game's map) sits on the world mask. Returns
 * {zoom, x0, y0, score}: the screenshot is `zoom` screenshot pixels per world-mask pixel, and its top-left
 * corner is at (x0, y0) in world-mask pixels. Null if nothing matches well enough.
 * Async only so the window can breathe between zoom steps; it takes a second or two.
 */
async function registerToWorld(image, { world = loadWorldMask(), minScore = 0.45, zooms = null, hint = null } = {}) {
  const shot = integral(landMask(image));

  // A previous registration is a strong hint: the map is usually where it was a few seconds ago, so
  // only look close to it (about a fifth of the work). Falls through to the full search if it no longer fits.
  if (hint) {
    let best = null;
    for (let f = 0.9; f <= 1.1001; f += 0.025) {
      const z = hint.zoom * f;
      const tw = Math.round(image.width / z), th = Math.round(image.height / z);
      if (tw < 8 || th < 8 || tw >= world.width || th >= world.height) continue;
      const m = bestMatch({ width: world.width, height: world.height, values: world.values }, boxResample(shot, tw, th),
        { xs: [hint.x0 - 14, hint.x0 + 14], ys: [hint.y0 - 14, hint.y0 + 14] });
      if (!best || m.score > best.score) best = { zoom: image.width / tw, x0: m.x, y0: m.y, score: m.score };
    }
    if (best && best.score >= Math.max(minScore, (hint.score || 0) - 0.15)) return best;
  }
  const coarseWorld = boxResample(integral(world), Math.round(world.width / COARSE), Math.round(world.height / COARSE));

  // Coarse: every zoom from "whole world fits" to "a few hundred metres across", picking the best place.
  const candidates = [];
  const zoomList = zooms || (() => {
    const list = [];
    for (let z = 1.2; z <= 40; z *= 1.07) list.push(z);
    return list;
  })();
  for (const z of zoomList) {
    const tw = Math.round(image.width / z / COARSE), th = Math.round(image.height / z / COARSE);
    if (tw < 10 || th < 10 || tw >= coarseWorld.width || th >= coarseWorld.height) continue;
    const tpl = boxResample(shot, tw, th);
    const m = bestMatch(coarseWorld, tpl);
    candidates.push({ zoom: z, x: m.x * COARSE, y: m.y * COARSE, score: m.score });
    await tick();
  }
  candidates.sort((a, b) => b.score - a.score);
  if (!candidates.length || candidates[0].score < minScore * 0.7) return null;

  // Fine: around the best few, at full world-mask resolution, narrow zoom and position steps.
  const worldFull = { width: world.width, height: world.height, values: world.values };
  let best = null;
  for (const c of candidates.slice(0, 3)) {
    for (let f = 0.94; f <= 1.0601; f += 0.015) {
      const z = c.zoom * f;
      const tw = Math.round(image.width / z), th = Math.round(image.height / z);
      if (tw < 8 || th < 8 || tw >= world.width || th >= world.height) continue;
      const tpl = boxResample(shot, tw, th);
      const m = bestMatch(worldFull, tpl, { xs: [c.x - COARSE * 2, c.x + COARSE * 2], ys: [c.y - COARSE * 2, c.y + COARSE * 2] });
      if (!best || m.score > best.score) best = { zoom: image.width / tw, x0: m.x, y0: m.y, score: m.score };
    }
    await tick();
  }
  return best && best.score >= minScore ? best : null;
}

/**
 * The whole fix: marker + registration -> {xNm, yNm, score, zoom, markerPixels}, or {error}.
 * xNm/yNm are on the radar grid (x east, y south, origin north-west).
 */
async function fixFromMap(image, options = {}) {
  const marker = findMarker(image);
  if (!marker) return { error: 'no green aircraft marker found on the map' };
  const world = options.world || loadWorldMask();
  const reg = await registerToWorld(image, { ...options, world });
  if (!reg) return { error: 'could not match this map view to the world - zoom out a little so some coastline is visible' };
  const wx = reg.x0 + marker.x / reg.zoom, wy = reg.y0 + marker.y / reg.zoom;
  return { xNm: wx / world.pxPerNm, yNm: wy / world.pxPerNm, score: reg.score, zoom: reg.zoom, x0: reg.x0, y0: reg.y0, markerPixels: marker.pixelCount };
}

module.exports = { findMarker, landMask, registerToWorld, fixFromMap, loadWorldMask, isMarkerGreen };
