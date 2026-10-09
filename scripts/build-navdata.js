#!/usr/bin/env node
// Builds planner/data/navdata.json - every airport and every named
// waypoint/VOR, all in the same lat/lon the companion app tracks pilots in
// (data/charts/*.json "coordinates", see companion/lib/coords.js), so the
// flight planner's routes and the companion's FMS/autopilot agree on where
// everything is.
//
// Airports come straight from data/charts. Waypoints/VORs only exist in
// 365Radar's fixes.js (upstream 24radar), in 24radar's own map coordinates
// - the same system as GroundOffsets.js's airport x/y. So this fits a
// least-squares affine transform from GroundOffsets' upstream airports
// (the ones 24radar itself measured, not AutoATC's estimated additions) to
// those same airports' chart lat/lon, and pushes every fix through it. The
// fit's per-airport error is written into the output (fit.residualsNm) so
// how far off a waypoint may be stays visible, not hidden.
//
// Re-run after changing charts or fixes:  node scripts/build-navdata.js

const fs = require('fs');
const path = require('path');
const { parseCoordinates } = require('../companion/lib/coords');

const ROOT = path.join(__dirname, '..');
const RADAR_DATA = path.join(ROOT, 'monitor', 'public', '365radar', 'src', 'data');
const OUT = path.join(ROOT, 'planner', 'data', 'navdata.json');

const round = (n, places) => Math.round(n * 10 ** places) / 10 ** places;

function loadChartAirports() {
  const dir = path.join(ROOT, 'data', 'charts');
  const airports = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const chart = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const coords = parseCoordinates(chart.coordinates);
    if (!coords) continue;
    const elevation = parseInt(String(chart.elevationFt || '').replace(/[^\d-]/g, ''), 10);
    airports.push({
      icao: chart.icao,
      name: chart.name || chart.icao,
      lat: round(coords.lat, 5),
      lon: round(coords.lon, 5),
      elevationFt: Number.isFinite(elevation) ? elevation : 0,
      runways: (chart.runways || []).map((r) => ({
        id: r.designator,
        headingDeg: parseInt(String(r.heading || '').replace(/\D/g, ''), 10) || null,
      })),
    });
  }
  return airports.sort((a, b) => a.icao.localeCompare(b.icao));
}

// GroundOffsets.js marks where 24radar's own measured airports end and
// AutoATC's estimated additions begin - only the former are fit against.
function loadUpstreamAirportOffsets() {
  const source = fs.readFileSync(path.join(RADAR_DATA, 'GroundOffsets.js'), 'utf8');
  const upstream = source.split('AutoATC additions')[0];
  const offsets = {};
  for (const m of upstream.matchAll(/"(\w+)":\s*\{[^}]*x:\s*(-?[\d.]+),\s*y:\s*(-?[\d.]+)/g)) {
    offsets[m[1]] = { x: Number(m[2]), y: Number(m[3]) };
  }
  return offsets;
}

function loadFixes() {
  const source = fs.readFileSync(path.join(RADAR_DATA, 'fixes.js'), 'utf8');
  const fixes = [];
  for (const m of source.matchAll(/"?x"?:\s*(-?[\d.]+),\s*"?y"?:\s*(-?[\d.]+),\s*type:\s*'(\w+)',\s*identifier:\s*'(\w+)'/g)) {
    fixes.push({ x: Number(m[1]), y: Number(m[2]), type: m[3], ident: m[4] });
  }
  return fixes;
}

// Least squares for A·p = b via the normal equations (3 unknowns here).
function leastSquares(rows, targets) {
  const n = rows[0].length;
  const m = [...Array(n)].map((_, i) => [
    ...[...Array(n)].map((_, j) => rows.reduce((s, r) => s + r[i] * r[j], 0)),
    rows.reduce((s, r, k) => s + r[i] * targets[k], 0),
  ]);
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let k = i + 1; k < n; k++) if (Math.abs(m[k][i]) > Math.abs(m[pivot][i])) pivot = k;
    [m[i], m[pivot]] = [m[pivot], m[i]];
    for (let k = 0; k < n; k++) {
      if (k === i) continue;
      const f = m[k][i] / m[i][i];
      for (let j = i; j <= n; j++) m[k][j] -= f * m[i][j];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}

function main() {
  const airports = loadChartAirports();
  const byIcao = new Map(airports.map((a) => [a.icao, a]));
  const offsets = loadUpstreamAirportOffsets();
  const fitIcaos = Object.keys(offsets).filter((icao) => byIcao.has(icao));
  if (fitIcaos.length < 3) throw new Error(`need at least 3 airports to fit against, found ${fitIcaos.length}`);

  // GroundOffsets x/y are 24radar SVG units; fixes.js x/y become those same
  // units via fix / 33.4 + (20, 12) - see 365radar/src/main.js drawFixes().
  const rows = fitIcaos.map((icao) => [offsets[icao].x, offsets[icao].y, 1]);
  const latCoef = leastSquares(rows, fitIcaos.map((icao) => byIcao.get(icao).lat));
  const lonCoef = leastSquares(rows, fitIcaos.map((icao) => byIcao.get(icao).lon));
  const toLatLon = (x, y) => ({
    lat: latCoef[0] * x + latCoef[1] * y + latCoef[2],
    lon: lonCoef[0] * x + lonCoef[1] * y + lonCoef[2],
  });

  const residualsNm = {};
  for (const icao of fitIcaos) {
    const fitted = toLatLon(offsets[icao].x, offsets[icao].y);
    const real = byIcao.get(icao);
    const north = (fitted.lat - real.lat) * 60;
    const east = (fitted.lon - real.lon) * 60 * Math.cos((real.lat * Math.PI) / 180);
    residualsNm[icao] = round(Math.hypot(north, east), 2);
  }
  const errors = Object.values(residualsNm).sort((a, b) => a - b);

  const fixes = loadFixes().map((f) => {
    const { lat, lon } = toLatLon(f.x / 33.4 + 20, f.y / 33.4 + 12);
    return { ident: f.ident, type: f.type === 'waypoint' ? 'WPT' : 'VOR', lat: round(lat, 5), lon: round(lon, 5) };
  });

  const navdata = {
    generatedBy: 'scripts/build-navdata.js',
    note: 'Airports are chart positions. Waypoints/VORs are converted from 24radar map coordinates with a fitted transform - see fit.residualsNm for how far each fitting airport landed from its chart position.',
    fit: {
      airports: fitIcaos.length,
      medianErrorNm: errors[Math.floor(errors.length / 2)],
      maxErrorNm: errors[errors.length - 1],
      residualsNm,
    },
    airports,
    fixes,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(navdata, null, 1)}\n`);
  console.log(
    `Wrote ${path.relative(ROOT, OUT)}: ${airports.length} airports, ${fixes.length} fixes ` +
      `(fit on ${fitIcaos.length} airports, median error ${navdata.fit.medianErrorNm} nm, max ${navdata.fit.maxErrorNm} nm)`
  );
}

main();
