const test = require('node:test');
const assert = require('node:assert');
const { standFix, listStands } = require('../companion/lib/stands');
const { loadAirports, nearestAirport } = require('../companion/lib/airports');

// The radar's ground view converts world pixels back to chart units with exactly this (monitor/public/365radar/src/main.js worldToGround).
const GROUND_UNITS_PER_NM = 1 / (0.000304886 * 100);
const radarGround = (worldPx) => ({ x: (worldPx.x / 24 - 22.0615) * GROUND_UNITS_PER_NM, y: (worldPx.y / 24 - 15.0392) * GROUND_UNITS_PER_NM });

test('stand data covers the airports whose chart has stand numbers', () => {
  const stands = listStands();
  assert.deepStrictEqual(Object.keys(stands).sort(), ['IPPH', 'IRFD', 'ITKO']);
  assert.strictEqual(stands.IRFD.length, 20);
});

test('a stand fix lands on the stand, and the radar draws it there', () => {
  const fix = standFix('IRFD', '12', 292);
  assert.ok(!fix.error);
  const airports = loadAirports();
  // What the monitor receives: distance/bearing from the nearest airport, rounded as the uploader rounds it...
  const near = nearestAirport(airports, fix.world);
  const rad = (near.bearingDeg * Math.PI) / 180;
  const a = require('../data/worldAnchors.json').airports[near.icao];
  const d = Math.round(near.distanceNm * 100) / 100, b = Math.round(near.bearingDeg * 10) / 10;
  const px = { x: (a.xNm + d * Math.sin((b * Math.PI) / 180)) * 24, y: (a.yNm - d * Math.cos((b * Math.PI) / 180)) * 24 };
  // ...which the radar turns into ground-chart units. Stand 12's line runs from (-30.357, 210.254) to (-29.196, 210.719).
  const g = radarGround(px);
  assert.ok(Math.abs(g.x - -29.7765) < 0.2 && Math.abs(g.y - 210.4865) < 0.2, `${g.x}, ${g.y}`);
  assert.ok(rad >= 0);
});

test('the heading is checked against the stand line', () => {
  assert.strictEqual(standFix('IRFD', '12', 112).headingOk, true);
  assert.strictEqual(standFix('IRFD', '12', 292).headingOk, true); // either way along the line (nose in or pushed back)
  assert.strictEqual(standFix('IRFD', '12', 200).headingOk, false);
  assert.strictEqual(standFix('IRFD', '12').headingOk, undefined);
});

test('bad stand numbers and airports say so', () => {
  assert.match(standFix('IRFD', '99').error, /no stand 99/);
  assert.match(standFix('IMLR', '1').error, /no stand data/);
  assert.strictEqual(standFix('IRFD', '012').stand, '12');
});

test('airport nudges move the stand fix; the pilot\'s own beats the shipped one', () => {
  const plain = standFix('IRFD', '12');
  const nudged = standFix('IRFD', '12', null, { IRFD: { dxNm: 0.1, dyNm: -0.05 } });
  assert.ok(Math.abs(nudged.xNm - plain.xNm - 0.1) < 1e-9 && Math.abs(nudged.yNm - plain.yNm + 0.05) < 1e-9);
  // ITKO ships a measured nudge (the chart sits ~0.22 nm off the real map there)
  const itko = standFix('ITKO', '22');
  const raw = standFix('ITKO', '22', null, { ITKO: { dxNm: 0, dyNm: 0 } });
  assert.ok(Math.abs(itko.xNm - raw.xNm + 0.181) < 1e-6 && Math.abs(itko.yNm - raw.yNm + 0.134) < 1e-6);
});
