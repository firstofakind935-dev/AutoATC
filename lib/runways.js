// Runway thresholds from the ground charts (data/runways.json, read off them by scripts/build-runways.js). Used when
// ATC lines an aircraft up: the aircraft is put just past the threshold, pointing down the runway.

const fs = require('fs');
const path = require('path');
const World = require('./world');
const { shippedOffsets } = require('./stands');

const FILES = [path.join(__dirname, '..', '..', 'data', 'runways.json'), path.join(__dirname, '..', 'data', 'runways.json')];
const LINE_UP_NM = 0.03; // about 55 m past the threshold, where an aircraft sits when lined up

let cache = null;
function load() {
  if (!cache) {
    const file = FILES.find((f) => fs.existsSync(f));
    cache = file ? JSON.parse(fs.readFileSync(file, 'utf8')).airports || {} : {};
  }
  return cache;
}

function listRunways() {
  return Object.fromEntries(Object.entries(load()).map(([icao, r]) => [icao, Object.keys(r)]));
}

const normalize = (rwy) => String(rwy || '').toUpperCase().replace(/^RWY?\s*/, '').replace(/^0+(?=\d)/, '');

/** -> {xNm, yNm, world, headingDeg, runway} on the radar grid, or {error}. `userNudges` as for stands (chart vs real map). */
function runwayFix(icao, runway, userNudges = {}) {
  const apt = String(icao || '').toUpperCase();
  const runways = load()[apt];
  if (!runways) return { error: `no runway data for ${icao || 'that airport'}` };
  const name = normalize(runway);
  const r = runways[name];
  if (!r) return { error: `${apt} has no runway ${runway || '?'} (${Object.keys(runways).join(', ')})` };
  const h = (r.headingDeg * Math.PI) / 180;
  const base = World.studsToWorld(r.x * 100, r.y * 100);
  const nudge = userNudges[apt] || shippedOffsets()[apt] || { dxNm: 0, dyNm: 0 };
  const xNm = base.xNm + LINE_UP_NM * Math.sin(h) + nudge.dxNm;
  const yNm = base.yNm - LINE_UP_NM * Math.cos(h) + nudge.dyNm;
  return { xNm, yNm, world: World.worldToFlat(xNm, yNm), headingDeg: r.headingDeg, runway: name };
}

module.exports = { runwayFix, listRunways };
