#!/usr/bin/env node
// Builds planner/data/navdata.json - every airport and every named
// waypoint/VOR, in the same lat/lon the companion app tracks pilots in
// (data/charts/*.json "coordinates", see companion/lib/coords.js), so the
// flight planner's routes and the companion's FMS/autopilot agree on where
// everything is.
//
// Airports come straight from data/charts. Waypoints/VORs come from 24SPY
// (Tiago Murteira / tiaguinho_2009, non-commercial licence - see
// monitor/public/365radar/src/data/24SPY-NOTICE.md), whose map is north-up
// at 24 px per nautical mile in the radar's world-map space. A fix is placed
// relative to the airports around it: each airport that both 24SPY and the
// charts know gives "chart position + (fix - airport) in 24SPY's map", and
// the nearby airports' answers are blended (inverse-distance weighted), so a
// fix lands right next to the airport it is near and nothing jumps between
// islands. That keeps fixes consistent with how pilots are tracked - as a
// distance and bearing from an airport. (The charts and 24SPY disagree about
// where some airports sit by 2-9 nm; this follows the charts for airports and
// 24SPY for everything relative to them.)
//
// Re-run after changing charts or 24SPY data:  node scripts/build-navdata.js

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

const PX_PER_NM = 24; // the radar world map (and so 24SPY data as imported) is 24 px per nm

/** 24SPY airports, waypoints and VORs as imported by scripts/import-24spy.js (world-map pixel space). */
function loadSpyData() {
  const text = fs.readFileSync(path.join(RADAR_DATA, 'spy24Data.js'), 'utf8');
  return JSON.parse(text.slice(text.indexOf('export default') + 'export default'.length).trim().replace(/;$/, ''));
}

function main() {
  const airports = loadChartAirports();
  const byIcao = new Map(airports.map((a) => [a.icao, a]));
  const spy = loadSpyData();
  const anchors = spy.airports.filter((a) => byIcao.has(a.icao)).map((a) => ({ ...a, chart: byIcao.get(a.icao) }));
  if (anchors.length < 3) throw new Error(`need at least 3 airports known to both the charts and 24SPY, found ${anchors.length}`);

  const placeFix = (fx, fy) => {
    let wSum = 0, lat = 0, lon = 0;
    for (const a of anchors) {
      const dist = Math.max(0.5, Math.hypot(fx - a.x, fy - a.y) / PX_PER_NM); // nm, floored so an exact hit doesn't divide by zero
      const w = 1 / dist ** 3;
      const northNm = -(fy - a.y) / PX_PER_NM;
      const eastNm = (fx - a.x) / PX_PER_NM;
      lat += w * (a.chart.lat + northNm / 60);
      lon += w * (a.chart.lon + eastNm / (60 * Math.cos((a.chart.lat * Math.PI) / 180)));
      wSum += w;
    }
    return { lat: lat / wSum, lon: lon / wSum };
  };

  const fixes = spy.waypoints.map((w) => {
    const { lat, lon } = placeFix(w.x, w.y);
    // xNm / yNm: the same point on the world grid (nautical miles, x east, y south) that 24SPY's own
    // positions and the live aircraft feed share - what the autopilot flies when it has true positions.
    return { ident: w.id, type: w.type === 'vor' ? 'VOR' : 'WPT', lat: round(lat, 5), lon: round(lon, 5), xNm: round(w.x / PX_PER_NM, 3), yNm: round(w.y / PX_PER_NM, 3) };
  });

  // How far apart the charts and 24SPY put each shared airport, relative to the
  // other shared airports (removing the overall shift): the size of the warp.
  const meanDelta = anchors.reduce((s, a) => [s[0] + (a.chart.lon * 60 * Math.cos((a.chart.lat * Math.PI) / 180) - a.x / PX_PER_NM) / anchors.length, s[1] + (a.chart.lat * 60 + a.y / PX_PER_NM) / anchors.length], [0, 0]);
  const disagreementNm = {};
  for (const a of anchors) {
    const east = a.chart.lon * 60 * Math.cos((a.chart.lat * Math.PI) / 180) - a.x / PX_PER_NM - meanDelta[0];
    const north = a.chart.lat * 60 + a.y / PX_PER_NM - meanDelta[1];
    disagreementNm[a.icao] = round(Math.hypot(east, north), 2);
  }
  const errors = Object.values(disagreementNm).sort((x, y) => x - y);

  // Airports 24SPY also knows get world-grid positions too.
  const spyAirports = new Map(spy.airports.map((a) => [a.icao, a]));
  for (const a of airports) {
    const sp = spyAirports.get(a.icao);
    if (sp) { a.xNm = round(sp.x / PX_PER_NM, 3); a.yNm = round(sp.y / PX_PER_NM, 3); }
  }

  const navdata = {
    generatedBy: 'scripts/build-navdata.js',
    note: 'Airports are chart positions. Waypoints/VORs are 24SPY positions placed relative to the airports around them (blended) - see fit.disagreementNm for where the charts and 24SPY disagree about airport positions.',
    source: { fixes: 'https://github.com/tiaguinho2009/24SPY by Tiago Murteira (tiaguinho_2009); modified; non-commercial use only' },
    fit: {
      anchorAirports: anchors.length,
      medianDisagreementNm: errors[Math.floor(errors.length / 2)],
      maxDisagreementNm: errors[errors.length - 1],
      disagreementNm,
    },
    airports,
    fixes,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(navdata, null, 1)}\n`);
  console.log(
    `Wrote ${path.relative(ROOT, OUT)}: ${airports.length} airports, ${fixes.length} fixes ` +
      `(placed from ${anchors.length} anchor airports; charts vs 24SPY disagree by a median ${navdata.fit.medianDisagreementNm} nm, max ${navdata.fit.maxDisagreementNm} nm)`
  );
}

main();
