// Public, read-only data API for community-built radars (see the
// /developers site in developers/ and the README's "Public radar data API"
// section). Everything here is safe to hand to any browser on any origin:
// it only ever exposes what /api/dashboard/positions already serves openly
// (live traffic position), reshaped so a third-party radar doesn't have to
// re-derive 365Radar's map math itself.
//
// Versioned under /api/public/v1 on purpose - an external site can't be
// migrated in lockstep with this repo, so a breaking shape change means a
// new /v2 alongside this one, never an edit to v1's fields.

const fs = require('fs');
const path = require('path');
const express = require('express');

const WORLD_MAP_DIR = path.join(__dirname, 'public', '365radar', 'public', 'assets');

// worldMapAnchors.js is an ES module (`export default {...}`) for the
// 365radar bundle, but its body is plain JSON - read it as that, so the
// browser radar and this API share one source of truth for where every
// airport sits on world-map.png.
function loadWorldMapAnchors() {
  const source = fs.readFileSync(
    path.join(__dirname, 'public', '365radar', 'src', 'data', 'worldMapAnchors.js'),
    'utf8'
  );
  const json = source.trim().replace(/^export default/, '').trim().replace(/;$/, '');
  return JSON.parse(json);
}

const worldMap = loadWorldMapAnchors();

const MAP_INFO = {
  imageUrl: '/api/public/v1/map.png',
  width: worldMap.imageWidth,
  height: worldMap.imageHeight,
  pxPerNm: worldMap.pxPerNm,
  // Bearings are degrees true, clockwise from north (up on the image).
  // Pixel y grows downward, as on any image.
  projection: 'x = anchor.x + distanceNm * pxPerNm * sin(bearing); y = anchor.y - distanceNm * pxPerNm * cos(bearing)',
};

// Same math as 365radar/src/main.js's adaptPositionsToAircraftData() (minus
// its internal *100 storage convention) - keep the two in step.
function toMapPixel(position) {
  const anchor = worldMap.anchors[position?.referenceAirport];
  if (!anchor || typeof position.distanceNm !== 'number' || typeof position.bearingDeg !== 'number') return null;
  const rad = (position.bearingDeg * Math.PI) / 180;
  return {
    x: Math.round((anchor.x + position.distanceNm * worldMap.pxPerNm * Math.sin(rad)) * 10) / 10,
    y: Math.round((anchor.y - position.distanceNm * worldMap.pxPerNm * Math.cos(rad)) * 10) / 10,
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
    speedKt: numberOrNull(row.speed),
    altitudeFt: numberOrNull(p.altitudeFt),
    headingDeg: numberOrNull(p.headingDeg),
    squawk: typeof p.squawk === 'string' ? p.squawk : null,
    identing: p.identing === true,
    referenceAirport: typeof p.referenceAirport === 'string' ? p.referenceAirport : null,
    distanceNm: numberOrNull(p.distanceNm),
    bearingDeg: numberOrNull(p.bearingDeg),
    map: toMapPixel(p),
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
      map: MAP_INFO,
      aircraft: getPositions().map(toPublicAircraft),
    });
  });

  router.get('/airports', (req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.json({
      map: MAP_INFO,
      airports: Object.entries(worldMap.anchors).map(([icao, a]) => ({
        icao,
        x: a.x,
        y: a.y,
        confidence: a.confidence,
      })),
    });
  });

  router.get('/map.png', (req, res) => {
    res.set('Cache-Control', 'public, max-age=3600');
    res.sendFile(worldMap.image, { root: WORLD_MAP_DIR });
  });

  router.use((req, res) => res.status(404).json({ error: 'unknown public API route' }));
  return router;
}

module.exports = { createPublicApiRouter, toPublicAircraft, toMapPixel };
