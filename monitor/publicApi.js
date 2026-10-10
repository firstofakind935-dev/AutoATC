// Public, read-only location data API for community-built radars (see the
// /developers site in developers/ and the README's "Public radar data API"
// section). It only ever exposes what /api/dashboard/positions already
// serves openly - live traffic position - plus where each airport sits, so
// a radar can show the whole world at once. Deliberately no map imagery:
// no world map image and no pixel coordinates on it. Everything is in
// nautical miles on a flat world grid, and what a radar draws underneath
// is up to whoever builds it.
//
// Versioned under /api/public/v1 on purpose - an external site can't be
// migrated in lockstep with this repo, so a breaking shape change means a
// new /v2 alongside this one, never an edit to v1's fields.

const fs = require('fs');
const path = require('path');
const express = require('express');

// worldMapAnchors.js is an ES module (`export default {...}`) for the
// 365radar bundle, but its body is plain JSON - read it as that, so 365Radar
// and this API share one source of truth for where every airport is.
function loadWorldMapAnchors() {
  const source = fs.readFileSync(
    path.join(__dirname, 'public', '365radar', 'src', 'data', 'worldMapAnchors.js'),
    'utf8'
  );
  return JSON.parse(source.trim().replace(/^export default/, '').trim().replace(/;$/, ''));
}

// 365Radar draws every airport at its 24SPY position (main.js overrides the anchors with spy24Data's
// airports) - do the same, so a position computed from "distance and bearing from IRFD" is the same point
// here as on the radar.
function loadSpyAirports() {
  try {
    const source = fs.readFileSync(path.join(__dirname, 'public', '365radar', 'src', 'data', 'spy24Data.js'), 'utf8');
    return JSON.parse(source.replace(/^\s*\/\/.*\n/gm, '').trim().replace(/^export default/, '').trim().replace(/;$/, '')).airports || [];
  } catch {
    return [];
  }
}
const worldMap = loadWorldMapAnchors();
for (const ap of loadSpyAirports()) worldMap.anchors[ap.icao] = { ...(worldMap.anchors[ap.icao] || {}), x: ap.x, y: ap.y, confidence: '24SPY' };

const round2 = (n) => Math.round(n * 100) / 100;

// The world grid: origin at the north-west corner, x grows east, y grows
// south (like screen coordinates), both in nautical miles. It's the
// world-map.png anchors divided by its px-per-nm scale - the same geometry
// 365Radar uses, minus the image.
const WORLD = {
  units: 'nm',
  axes: 'origin at the north-west corner; x grows east, y grows south',
  widthNm: round2(worldMap.imageWidth / worldMap.pxPerNm),
  heightNm: round2(worldMap.imageHeight / worldMap.pxPerNm),
};

// How each anchor was measured, in plain terms (see worldMapAnchors.js's
// own "note" for the detail).
function placementOf(confidence) {
  if (confidence.startsWith('direct') || confidence === '24SPY') return 'measured';
  if (confidence.startsWith('derived')) return 'derived';
  return 'estimated';
}

const AIRPORTS = Object.entries(worldMap.anchors).map(([icao, a]) => ({
  icao,
  xNm: round2(a.x / worldMap.pxPerNm),
  yNm: round2(a.y / worldMap.pxPerNm),
  placement: placementOf(a.confidence),
}));
const airportsByIcao = new Map(AIRPORTS.map((a) => [a.icao, a]));

// Distance/bearing from a reference airport -> world grid position. Same
// projection as 365radar/src/main.js's adaptPositionsToAircraftData().
function toWorld(p) {
  const airport = airportsByIcao.get(p.referenceAirport);
  if (!airport || typeof p.distanceNm !== 'number' || typeof p.bearingDeg !== 'number') return { xNm: null, yNm: null };
  const rad = (p.bearingDeg * Math.PI) / 180;
  return {
    xNm: round2(airport.xNm + p.distanceNm * Math.sin(rad)),
    yNm: round2(airport.yNm - p.distanceNm * Math.cos(rad)),
  };
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// Flattens one freshPositions() row into the documented public shape. Only
// whitelisted fields go out - `position` is opaque on ingest (see
// POST /api/position), so anything the companion app adds later stays
// private until it's deliberately added here.
function toPublicAircraft(row) {
  const p = row.position || {};
  return {
    callsign: row.callsign,
    aircraftType: row.aircraftType,
    referenceAirport: typeof p.referenceAirport === 'string' ? p.referenceAirport : null,
    distanceNm: numberOrNull(p.distanceNm),
    bearingDeg: numberOrNull(p.bearingDeg),
    ...toWorld(p),
    altitudeFt: numberOrNull(p.altitudeFt),
    speedKt: numberOrNull(row.speed),
    headingDeg: numberOrNull(p.headingDeg),
    squawk: typeof p.squawk === 'string' ? p.squawk : null,
    identing: p.identing === true,
    fixAgeSec: numberOrNull(p.fixAgeSec),
    reportAgeMs: row.ageMs,
    assignedHeadingDeg: numberOrNull(row.assignedHeadingDeg),
    vectorReason: row.vectorReason ?? null,
  };
}

function allowAnyOrigin(req, res, next) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}

function createPublicApiRouter({ getPositions }) {
  const router = express.Router();
  router.use(allowAnyOrigin);

  router.get('/traffic', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      generatedAt: new Date().toISOString(),
      world: WORLD,
      aircraft: getPositions().map(toPublicAircraft),
    });
  });

  router.get('/airports', (req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ world: WORLD, airports: AIRPORTS });
  });

  router.use((req, res) => res.status(404).json({ error: 'unknown public API route' }));
  return router;
}

module.exports = { createPublicApiRouter, toPublicAircraft };
