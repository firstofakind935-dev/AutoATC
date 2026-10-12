#!/usr/bin/env node
// Imports waypoints, airways and FIR/TMA airspace outlines from 24SPY
// (https://github.com/tiaguinho2009/24SPY, by Tiago Murteira / tiaguinho_2009)
// into 365Radar's own map space, as monitor/public/365radar/src/data/spy24Data.js.
//
// 24SPY positions things in its own 1200 x 1200 map units. 365Radar draws on
// public/assets/world-map.png (937 x 706 px, see worldMapAnchors.js). Both
// are tied to the exact game frame of 24RC's coast.svg by island-shape fits
// (data/gameFrame.json: world-map picture within 3-60 m, 24SPY's tiles within
// ~0.03 nm), so 24SPY units -> game -> world-map pixels is exact. (This used
// to fit 24SPY's airport points to 24Radar's airport anchors, which left a
// ~1% scale error: up to 0.28 nm at the map edges.) How far each airport now
// sits from 24Radar's anchor is written into the output header.
//
// 24SPY is under a non-commercial, attribution-required licence (see
// 24SPY-NOTICE.md next to the output). This script's output is the "changed"
// copy that licence asks to be marked as changed - the header says so.
//
// Usage: node scripts/import-24spy.js [path-to-24SPY-clone]
//   default clone path: /home/user/tiaguinho2009/24spy

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const CLONE = process.argv[2] || '/home/user/tiaguinho2009/24spy';
const ROOT = path.join(__dirname, '..');
const RADAR_DATA = path.join(ROOT, 'monitor', 'public', '365radar', 'src', 'data');
const OUT = path.join(RADAR_DATA, 'spy24Data.js');

// 24SPY's own lat/lon -> map-unit conversion (main.js grausParaXY), used for
// airway points written as coordinates like "32N13W". Note its convention:
// "E" longitudes are negated before use.
const ORIGIN_LAT = 54.07;
const ORIGIN_LON = 29.69;
const UNITS_PER_DEGREE = 24.45;

const round1 = (n) => Math.round(n * 10) / 10;

/** Pulls `const NAME = [ ... ]` out of areas.js and evaluates just that literal, in an empty sandbox. */
function grabArray(source, name) {
  const start = source.indexOf(`const ${name} = [`);
  if (start < 0) throw new Error(`24SPY areas.js has no "${name}" array - did its format change?`);
  const open = source.indexOf('[', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '[') depth++;
    else if (source[i] === ']' && --depth === 0) return vm.runInNewContext(source.slice(open, i + 1), {}, { timeout: 2000 });
  }
  throw new Error(`Could not find the end of the "${name}" array`);
}

/** 24SPY units -> world-map pixels through the exact game frame: spy -> game (inverse of spyFromGame) -> nm -> px. */
function spyToWorldPx(frame, pxPerNm) {
  const [[a, , tx], [b, , ty]] = frame.spyFromGame;
  const [[c, , ux], [d, , uy]] = frame.gridFromGame;
  const det = a * a + b * b;
  return (p) => {
    const x = p[0] - tx, y = p[1] - ty;
    const g = [(a * x + b * y) / det, (a * y - b * x) / det];
    return [(c * g[0] - d * g[1] + ux) * pxPerNm, (d * g[0] + c * g[1] + uy) * pxPerNm];
  };
}

function loadWorldMapPxPerNm() {
  const text = fs.readFileSync(path.join(RADAR_DATA, 'worldMapAnchors.js'), 'utf8');
  return JSON.parse(text.trim().replace(/^export default/, '').trim().replace(/;$/, '')).pxPerNm;
}

function loadWorldMapAnchors() {
  const text = fs.readFileSync(path.join(RADAR_DATA, 'worldMapAnchors.js'), 'utf8');
  return JSON.parse(text.trim().replace(/^export default/, '').trim().replace(/;$/, '')).anchors;
}

function main() {
  const areasSource = fs.readFileSync(path.join(CLONE, 'assets', 'areas.js'), 'utf8');
  const commit = execFileSync('git', ['-C', CLONE, 'log', '-1', '--format=%H %cs'], { encoding: 'utf8' }).trim();

  const controlAreas = grabArray(areasSource, 'controlAreas');
  const rawWaypoints = [...grabArray(areasSource, 'Waypoints'), ...grabArray(areasSource, 'CustomWaypoints')];
  const rawAirways = grabArray(areasSource, 'airways');

  // ---- fit 24SPY units -> world-map pixels on the airports both know
  const anchors = loadWorldMapAnchors();
  const spyAirports = Object.fromEntries(controlAreas.filter((a) => a.type === 'Airport' && Array.isArray(a.coordinates)).map((a) => [a.name, a.coordinates]));
  const frame = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'gameFrame.json'), 'utf8'));
  const transform = spyToWorldPx(frame, loadWorldMapPxPerNm());
  const shared = Object.keys(spyAirports).filter((icao) => anchors[icao]);
  const dist = (f, icao) => {
    const p = f(spyAirports[icao]);
    return Math.hypot(p[0] - anchors[icao].x, p[1] - anchors[icao].y);
  };
  const dropped = [];
  const residualsPx = Object.fromEntries(shared.map((icao) => [icao, round1(dist(transform, icao))]));
  const sorted = Object.values(residualsPx).sort((a, b) => a - b);
  const apply = (p) => transform(p).map(round1);

  // ---- waypoints (24SPY has one duplicate name; the first wins)
  const seen = new Set();
  const waypoints = [];
  for (const w of rawWaypoints) {
    if (seen.has(w.name)) continue;
    seen.add(w.name);
    const [x, y] = apply(w.coordinates);
    waypoints.push({ id: w.name, type: w.type === 'VOR' ? 'vor' : 'waypoint', x, y });
  }
  const spyPositions = new Map(rawWaypoints.map((w) => [w.name, w.coordinates]));

  // ---- airways: named points resolve to waypoints; "32N13W" style points are lat/lon
  const pointFor = (name) => {
    if (spyPositions.has(name)) return spyPositions.get(name);
    const m = name.match(/^(\d+(?:\.\d+)?)([NS])(\d+(?:\.\d+)?)([EW])$/);
    if (!m) return null;
    const lat = (m[2] === 'S' ? -1 : 1) * Number(m[1]);
    const lon = (m[4] === 'E' ? -1 : 1) * Number(m[3]);
    return [(ORIGIN_LON - lon) * UNITS_PER_DEGREE, (ORIGIN_LAT - lat) * UNITS_PER_DEGREE];
  };
  const airways = rawAirways.map((a) => {
    const resolved = a.points.map((name) => [name, pointFor(name)]);
    const missing = resolved.filter(([, p]) => !p).map(([n]) => n);
    if (missing.length) console.warn(`  airway ${a.name}: skipped unknown point(s) ${missing.join(', ')}`);
    return { name: a.name, points: resolved.filter(([, p]) => p).map(([n, p]) => [n, ...apply(p)]) };
  });

  // ---- airspace: FIR and TMA outlines (the CTR/APP entries reuse these)
  const areas = controlAreas
    .filter((a) => a.type === 'polyline' && /\b(FIR2?|TMA)$/.test(a.name) && Array.isArray(a.coordinates))
    .map((a) => ({ name: a.name, kind: a.name.endsWith('TMA') ? 'TMA' : 'FIR', points: a.coordinates.map(apply) }));

  // ---- airports: every one 24SPY lists, placed with the same fit, plus the
  // frequencies it records. `ours` is where worldMapAnchors.js puts the same
  // airport, so the disagreement is visible in the data instead of hidden.
  const freq = (v) => (v && v !== 'None' ? String(v) : null);
  const airports = controlAreas
    .filter((a) => a.type === 'Airport' && Array.isArray(a.coordinates))
    .map((a) => {
      const [x, y] = apply(a.coordinates);
      const out = { icao: a.name, name: a.real_name, x, y };
      if (anchors[a.name]) out.offsetFromAnchorPx = round1(Math.hypot(x - anchors[a.name].x, y - anchors[a.name].y));
      const f = { tower: freq(a.towerfreq), ground: freq(a.groundfreq) };
      for (const k of Object.keys(f)) if (f[k]) (out.freq ||= {})[k] = f[k];
      return out;
    });

  const meta = {
    source: 'https://github.com/tiaguinho2009/24SPY',
    author: 'Tiago Murteira (tiaguinho_2009)',
    licence: 'See 24SPY-NOTICE.md - attribution required, non-commercial use only',
    sourceCommit: commit,
    changes: 'Positions converted from 24SPY map units to world-map.png pixels through the exact game frame (island-shape fits, see data/gameFrame.json); airways resolved to coordinates; airports, FIR/TMA outlines and waypoints selected from areas.js. No other changes.',
    fit: {
      method: 'island-shape fits through the game frame (data/gameFrame.json); the numbers below are distances from 24Radar airport anchors, not fit errors',
      airports: shared.length,
      droppedAirports: dropped,
      medianErrorPx: sorted[Math.floor(sorted.length / 2)],
      maxErrorPx: sorted[sorted.length - 1],
      pxPerNm: 24,
      residualsPx,
    },
  };

  const header = `// GENERATED by scripts/import-24spy.js - do not edit by hand.
//
// Airports, waypoints, airways and FIR/TMA airspace outlines from 24SPY,
// ${meta.source}
// Original work by ${meta.author}. Used under the 24SPY licence (attribution
// required, non-commercial use only) - see 24SPY-NOTICE.md in this folder.
//
// THIS IS A MODIFIED COPY: ${meta.changes}
//
// Kept in its own file, not merged into fixes.js/worldMapAnchors.js, because
// those come from 24Radar (GPLv3) and 24SPY's licence is not GPL-compatible.
`;
  fs.writeFileSync(OUT, `${header}export default ${JSON.stringify({ meta, airports, waypoints, airways, areas }, null, 1)};\n`);
  console.log(
    `Wrote ${path.relative(ROOT, OUT)}: ${airports.length} airports, ${waypoints.length} waypoints, ${airways.length} airways, ${areas.length} areas ` +
      `(${shared.length} airports vs 24Radar anchors: ` +
      `median distance ${meta.fit.medianErrorPx}px = ${round1(meta.fit.medianErrorPx / 24)} nm, max ${meta.fit.maxErrorPx}px)`
  );
}

main();
