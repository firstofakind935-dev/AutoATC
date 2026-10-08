// Public, read-only location data API for community-built radars (see the
// /developers site in developers/ and the README's "Public radar data API"
// section). It only ever exposes what /api/dashboard/positions already
// serves openly - live traffic position - and deliberately nothing map-
// related: no world map image and no pixel coordinates on it. Each
// aircraft's position is the raw distance/bearing from a reference airport,
// and what a radar draws that on is up to whoever builds it.
//
// Versioned under /api/public/v1 on purpose - an external site can't be
// migrated in lockstep with this repo, so a breaking shape change means a
// new /v2 alongside this one, never an edit to v1's fields.

const express = require('express');

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
      aircraft: getPositions().map(toPublicAircraft),
    });
  });

  router.use((req, res) => res.status(404).json({ error: 'unknown public API route' }));
  return router;
}

module.exports = { createPublicApiRouter, toPublicAircraft };
