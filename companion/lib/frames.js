// Two maps are in play. Fixes taken from the minimap or the big map are matched on the world-map PICTURE, so they
// come out in the picture's frame. The radar's airport points, the ground charts and the stand positions are in the
// 24SPY / game frame. The two differ by a few hundred metres to over a nautical mile depending on where you are, and
// that gap is what put a parked aircraft in the wrong place on the ground view.
//
// data/pictureOffsets.json holds, per airport, how far the game-frame position is from the picture's. A fix near an
// airport is shifted by that airport's offset (fading out over FADE_NM, blending when two airports are close), and
// a pilot's own calibration at a stand (settings.airportOffsets) overrides the shipped value for that airport.

const fs = require('fs');
const path = require('path');

const FADE_NM = 6;
// A shipped offset bigger than this is more likely a bad hand-measured anchor on the picture than a real gap, so only
// a pilot's own calibration may apply one.
const MAX_SHIPPED_OFFSET_NM = 0.8;

const dataPath = (name) => [path.join(__dirname, '..', '..', 'data', name), path.join(__dirname, '..', 'data', name)].find((f) => fs.existsSync(f));
let cache = null;
function load() {
  if (cache) return cache;
  const read = (name) => {
    const file = dataPath(name);
    return file ? JSON.parse(fs.readFileSync(file, 'utf8')).airports || {} : {};
  };
  cache = { offsets: read('pictureOffsets.json'), points: read('worldAnchors.json') };
  return cache;
}

/**
 * Picture-frame point (nm) -> game-frame point. `userOffsets` is {ICAO: {dxNm, dyNm}} from the pilot's calibrations.
 * Returns {xNm, yNm, dxNm, dyNm, icao} - the shift that was applied and the airport that mostly set it.
 */
function pictureToGame(xNm, yNm, userOffsets = {}) {
  const { offsets, points } = load();
  let sum = 0, sx = 0, sy = 0, bestW = 0, bestIcao = null;
  const candidates = { ...Object.fromEntries(Object.entries(offsets).filter(([, o]) => Math.hypot(o.dxNm, o.dyNm) <= MAX_SHIPPED_OFFSET_NM)), ...userOffsets };
  for (const [icao, o] of Object.entries(candidates)) {
    const p = points[icao];
    if (!p || !Number.isFinite(o.dxNm) || !Number.isFinite(o.dyNm)) continue;
    // distance to where the PICTURE shows the airport (the game point minus the gap)
    const d = Math.hypot(xNm - (p.xNm - o.dxNm), yNm - (p.yNm - o.dyNm));
    const w = Math.max(0, 1 - d / FADE_NM);
    if (w === 0) continue;
    sum += w; sx += w * o.dxNm; sy += w * o.dyNm;
    if (w > bestW) { bestW = w; bestIcao = icao; }
  }
  const norm = Math.max(sum, 1);
  const dxNm = sx / norm, dyNm = sy / norm;
  return { xNm: xNm + dxNm, yNm: yNm + dyNm, dxNm, dyNm, icao: bestIcao };
}

module.exports = { pictureToGame, FADE_NM, MAX_SHIPPED_OFFSET_NM };
