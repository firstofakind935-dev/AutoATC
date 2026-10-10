// Position from a stand number. Parked at a stand, the pilot types its number and the companion puts them
// exactly where that stand is on the radar's ground chart (data/stands.json, read off the charts by
// scripts/build-stands.js) - a fix to a few metres, with no map or minimap involved. The heading is checked
// against the direction of the stand's line, so a wrong stand number is caught ("heading 250 does not
// fit stand 12's line, 070/250 - right stand?").

const fs = require('fs');
const path = require('path');
const World = require('./world');

// data/ sits two levels up in the repo (companion/lib/) and one level up in the standalone companion app.
const FILES = [path.join(__dirname, '..', '..', 'data', 'stands.json'), path.join(__dirname, '..', 'data', 'stands.json')];

let cache = null;
function load() {
  if (cache) return cache;
  const file = FILES.find((f) => fs.existsSync(f));
  cache = file ? JSON.parse(fs.readFileSync(file, 'utf8')).airports || {} : {};
  return cache;
}

/** { ICAO: ['1', '2', ...] } for every airport with stand data. */
function listStands() {
  return Object.fromEntries(Object.entries(load()).map(([icao, stands]) => [icao, Object.keys(stands).sort((a, b) => Number(a) - Number(b))]));
}

// Chart units are 100 studs; the chart is north-up with y growing south, like the world grid.
const unitsToWorld = (x, y) => World.studsToWorld(x * 100, y * 100);
const bearingOf = (a, b) => ((Math.atan2(b[0] - a[0], -(b[1] - a[1])) * 180) / Math.PI + 360) % 360;
// How far apart two directions are, ignoring which way along the line (0 to 90).
const axisDiff = (h, axis) => {
  const d = Math.abs(((h - axis + 540) % 360) - 180);
  return Math.min(d, 180 - d);
};

/**
 * Where stand `stand` at `icao` is, as {xNm, yNm, world: {lat, lon}} on the radar grid, or {error}.
 * `headingDeg` (optional) is checked against the stand line: headingOk says whether it fits.
 */
function standFix(icao, stand, headingDeg = null) {
  const stands = load()[String(icao || '').toUpperCase()];
  if (!stands) return { error: `no stand data for ${icao || 'that airport'} yet` };
  const key = String(stand || '').trim().replace(/^0+(?=\d)/, '');
  const s = stands[key];
  if (!s) return { error: `${icao} has no stand ${stand || '?'} (try ${Object.keys(stands).slice(0, 4).join(', ')}...)` };

  // The aircraft sits along the stand's line - its middle is the best single point. Stands drawn without a line use the number's own spot.
  const point = s.line ? [(s.line.a[0] + s.line.b[0]) / 2, (s.line.a[1] + s.line.b[1]) / 2] : [s.x, s.y];
  const { xNm, yNm } = unitsToWorld(point[0], point[1]);
  const out = { xNm, yNm, world: World.worldToFlat(xNm, yNm), stand: key, source: s.line ? 'stand line' : 'stand number' };
  if (s.line) {
    out.axisDeg = Math.round(bearingOf(s.line.a, s.line.b));
    if (typeof headingDeg === 'number') {
      const off = axisDiff(headingDeg, out.axisDeg);
      out.headingOk = off <= 40;
      out.headingOffDeg = Math.round(off);
    }
  }
  return out;
}

module.exports = { standFix, listStands };
