// Where the minimap is looking, by FEATURES - a port of the tracker's map_locator.py (test-pim-vpilot), which is
// what made automatic tracking work there.
//
// ORB keypoints (corners of runways, taxiways, buildings, coastline) are found in the minimap and matched against
// the radar's world map and the high-detail airport tiles (data/featureRefs/), then one similarity transform
// (scale + shift + a small rotation) that most matches agree on is fitted with RANSAC. A wrong place almost never
// gets many keypoints to agree, so the number that do is an honest confidence. The land/sea mask match in mapFix.js
// compares shapes only, and on a zoomed-out minimap that is ambiguous - a real screenshot parked at Rockford stand
// 14 was placed near Tokyo by it, and 0.03 nm from the stand by this.
//
// Uses OpenCV's WebAssembly build (@techstark/opencv-js). Images are plain {width, height, data} RGBA objects.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const REF_DIRS = [path.join(__dirname, '..', '..', 'data', 'featureRefs'), path.join(__dirname, '..', 'data', 'featureRefs')];

const MIN_INLIERS = 10;
const MIN_INLIER_RATIO = 0.4;
const MAX_ROTATION_DEG = 8; // the minimap is north-up; a fit that needs a big rotation is a wrong match
const RANSAC_PX = 4;
const WORLD_SCALES = [1.0, 0.5, 0.29, 0.17, 0.1];
const TILE_SCALES = [1.0, 0.7, 0.5, 1.4, 2.0, 0.35];

let cvPromise = null;
/** OpenCV, once its WebAssembly has started (a second or two the first time). */
function loadCv() {
  if (!cvPromise) {
    cvPromise = new Promise((resolve, reject) => {
      let cv;
      try { cv = require('@techstark/opencv-js'); } catch (err) { reject(err); return; }
      if (cv.Mat) resolve(cv);
      else if (typeof cv.then === 'function') cv.then((ready) => { delete ready.then; resolve(ready); });
      else cv.onRuntimeInitialized = () => resolve(cv);
    });
  }
  return cvPromise;
}

function refDir() {
  const dir = REF_DIRS.find((d) => fs.existsSync(path.join(d, 'index.json')));
  if (!dir) throw new Error('data/featureRefs is missing (scripts/build-feature-refs.py)');
  return dir;
}

/** Keypoints [{x, y}] and descriptors (a cv.Mat, kept) of a greyscale cv.Mat. */
function features(cv, gray, nfeatures) {
  const orb = new cv.ORB(nfeatures, 1.2, 8);
  const kpv = new cv.KeyPointVector();
  const desc = new cv.Mat();
  const none = new cv.Mat();
  orb.detectAndCompute(gray, none, kpv, desc);
  const kp = [];
  for (let i = 0; i < kpv.size(); i++) { const p = kpv.get(i).pt; kp.push({ x: p.x, y: p.y }); }
  kpv.delete(); none.delete(); orb.delete();
  return { kp, desc };
}

function loadGray(cv, dir, name, width, height) {
  const bytes = zlib.gunzipSync(fs.readFileSync(path.join(dir, `${name}.gray.gz`)));
  return cv.matFromArray(height, width, cv.CV_8UC1, bytes);
}

let refsPromise = null;
/** The world map's and every tile's features, computed once. */
function loadRefs() {
  if (!refsPromise) {
    refsPromise = (async () => {
      const cv = await loadCv();
      const dir = refDir();
      const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
      const worldGray = loadGray(cv, dir, 'world', index.world.width, index.world.height);
      const world = { name: 'world', ...features(cv, worldGray, 12000), toWorld: [[1, 0, 0], [0, 1, 0]], pxPerNm: index.world.pxPerNm };
      worldGray.delete();
      const tiles = [];
      for (const [name, t] of Object.entries(index.tiles || {})) {
        const g = loadGray(cv, dir, name, t.width, t.height);
        const f = features(cv, g, 8000);
        g.delete();
        const [[a, b, c], [d, e, f2]] = t.toWorld;
        const cx = t.width / 2, cy = t.height / 2;
        tiles.push({ name, ...f, toWorld: t.toWorld, center: [a * cx + b * cy + c, d * cx + e * cy + f2] });
      }
      return { cv, world, tiles, matcher: new cv.BFMatcher(cv.NORM_HAMMING, false) };
    })();
  }
  return refsPromise;
}

/** Least-squares similarity [[a, -b, tx], [b, a, ty]] from point pairs. */
function fitSimilarity(src, dst) {
  const n = src.length;
  let sx = 0, sy = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { sx += src[i].x; sy += src[i].y; dx += dst[i].x; dy += dst[i].y; }
  sx /= n; sy /= n; dx /= n; dy /= n;
  let dot = 0, cross = 0, norm = 0;
  for (let i = 0; i < n; i++) {
    const x = src[i].x - sx, y = src[i].y - sy, u = dst[i].x - dx, v = dst[i].y - dy;
    dot += x * u + y * v; cross += x * v - y * u; norm += x * x + y * y;
  }
  if (norm < 1e-9) return null;
  const a = dot / norm, b = cross / norm;
  return [[a, -b, dx - a * sx + b * sy], [b, a, dy - b * sx - a * sy]];
}

const apply = (M, p) => ({ x: M[0][0] * p.x + M[0][1] * p.y + M[0][2], y: M[1][0] * p.x + M[1][1] * p.y + M[1][2] });

/** RANSAC similarity (the tracker uses OpenCV's estimateAffinePartial2D, which the WebAssembly build lacks). */
function ransacSimilarity(src, dst, iterations = 400) {
  const n = src.length;
  let bestInliers = null;
  let seed = 12345; // deterministic: the same frame always gives the same answer
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let it = 0; it < iterations; it++) {
    const i = Math.floor(rand() * n);
    let j = Math.floor(rand() * n);
    if (j === i) j = (j + 1) % n;
    const M = fitSimilarity([src[i], src[j]], [dst[i], dst[j]]);
    if (!M) continue;
    const inl = [];
    for (let k = 0; k < n; k++) {
      const p = apply(M, src[k]);
      if (Math.hypot(p.x - dst[k].x, p.y - dst[k].y) <= RANSAC_PX) inl.push(k);
    }
    if (!bestInliers || inl.length > bestInliers.length) bestInliers = inl;
  }
  if (!bestInliers || bestInliers.length < 2) return null;
  const M = fitSimilarity(bestInliers.map((k) => src[k]), bestInliers.map((k) => dst[k]));
  if (!M) return null;
  const inliers = [];
  for (let k = 0; k < n; k++) {
    const p = apply(M, src[k]);
    if (Math.hypot(p.x - dst[k].x, p.y - dst[k].y) <= RANSAC_PX) inliers.push(k);
  }
  return { M, inliers: inliers.length };
}

/** One attempt at one scale: crop -> reference transform, inlier count and good-match count, or null. */
function featureTry(refs, crop, ref, scale) {
  const { cv, matcher } = refs;
  let img = crop;
  if (Math.abs(scale - 1) > 1e-6) {
    img = new cv.Mat();
    cv.resize(crop, img, new cv.Size(0, 0), scale, scale, scale < 1 ? cv.INTER_AREA : cv.INTER_LINEAR);
  }
  try {
    if (img.rows < 24 || img.cols < 24) return null;
    const { kp, desc } = features(cv, img, 2000);
    try {
      if (kp.length < MIN_INLIERS || desc.rows === 0) return null;
      const pairs = new cv.DMatchVectorVector();
      matcher.knnMatch(desc, ref.desc, pairs, 2);
      const src = [], dst = [];
      for (let i = 0; i < pairs.size(); i++) {
        const p = pairs.get(i);
        if (p.size() === 2) {
          const m = p.get(0), n = p.get(1);
          if (m.distance < 0.75 * n.distance) { src.push(kp[m.queryIdx]); dst.push(ref.kp[m.trainIdx]); }
        }
        p.delete();
      }
      pairs.delete();
      if (src.length < MIN_INLIERS) return null;
      const r = ransacSimilarity(src, dst);
      if (!r) return null;
      // back to crop pixels: the crop was resized by `scale` before matching
      const M = [[r.M[0][0] * scale, r.M[0][1] * scale, r.M[0][2]], [r.M[1][0] * scale, r.M[1][1] * scale, r.M[1][2]]];
      return { M, inliers: r.inliers, good: src.length };
    } finally {
      desc.delete();
    }
  } finally {
    if (img !== crop) img.delete();
  }
}

function featureLocate(refs, crop, ref, scales, hints) {
  const hint = hints.get(ref.name);
  const list = hint ? [hint, ...scales.filter((s) => Math.abs(s - hint) > 0.05)] : scales;
  let best = null;
  for (const sc of list) {
    const r = featureTry(refs, crop, ref, sc);
    if (!r) continue;
    const ratio = r.inliers / Math.max(1, r.good);
    const k = Math.sqrt(Math.abs(r.M[0][0] * r.M[1][1] - r.M[0][1] * r.M[1][0]));
    const rot = (Math.atan2(r.M[1][0], r.M[0][0]) * 180) / Math.PI;
    if (r.inliers < MIN_INLIERS || ratio < MIN_INLIER_RATIO || Math.abs(rot) > MAX_ROTATION_DEG || k <= 0) continue;
    if (!best || r.inliers > best.inliers) best = { ...r, ratio, scale: sc };
    if (r.inliers >= 25 && ratio >= 0.6) break; // clearly found; don't spend time on other scales
  }
  if (!best) return null;
  hints.set(ref.name, best.scale);
  return { M: best.M, confidence: Math.min(1, best.inliers / 15) * Math.min(1, best.ratio / 0.6), inliers: best.inliers };
}

const compose = (outer, inner) => [
  [outer[0][0] * inner[0][0] + outer[0][1] * inner[1][0], outer[0][0] * inner[0][1] + outer[0][1] * inner[1][1], outer[0][0] * inner[0][2] + outer[0][1] * inner[1][2] + outer[0][2]],
  [outer[1][0] * inner[0][0] + outer[1][1] * inner[1][0], outer[1][0] * inner[0][1] + outer[1][1] * inner[1][1], outer[1][0] * inner[0][2] + outer[1][1] * inner[1][2] + outer[1][2]],
];

/**
 * Locator with its own memory (the scale that worked last time, the last place it matched - nearest tile first).
 * locate(image, marker) -> {xNm, yNm, score, method} or null; image is the minimap (RGBA), marker {x, y} in it.
 */
function createLocator() {
  const hints = new Map();
  let lastWorldPx = null;
  return {
    async locate(image, marker) {
      const refs = await loadRefs();
      const { cv } = refs;
      const rgba = cv.matFromImageData(image);
      const gray = new cv.Mat();
      cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
      rgba.delete();
      try {
        // 1. the high-detail airport tiles, nearest first; 2. the world map itself
        const tiles = lastWorldPx
          ? [...refs.tiles].sort((a, b) => Math.hypot(a.center[0] - lastWorldPx[0], a.center[1] - lastWorldPx[1]) - Math.hypot(b.center[0] - lastWorldPx[0], b.center[1] - lastWorldPx[1]))
          : refs.tiles;
        let found = null, method = null;
        for (const tile of tiles) {
          const r = featureLocate(refs, gray, tile, TILE_SCALES, hints);
          if (r) { found = { ...r, M: compose(tile.toWorld, r.M) }; method = `tile ${tile.name}`; break; }
        }
        if (!found) {
          const r = featureLocate(refs, gray, refs.world, WORLD_SCALES, hints);
          if (r) { found = r; method = 'features'; }
        }
        if (!found) return null;
        lastWorldPx = [found.M[0][2], found.M[1][2]];
        const p = apply(found.M, marker);
        return { xNm: p.x / refs.world.pxPerNm, yNm: p.y / refs.world.pxPerNm, score: found.confidence, method, inliers: found.inliers };
      } finally {
        gray.delete();
      }
    },
  };
}

module.exports = { createLocator, loadRefs, ransacSimilarity, fitSimilarity };
