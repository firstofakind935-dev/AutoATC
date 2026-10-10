const test = require('node:test');
const assert = require('node:assert/strict');
const World = require('../companion/lib/world');
const { navdata } = require('../planner/lib/navdata');
const offsets = require('../src/flightradar365/groundOffsets');

test('the 16 measured airports land within 0.4 nm of their 24SPY positions', () => {
  const measured = ['IBLT', 'IBTH', 'IDCS', 'IGAR', 'IHEN', 'IIAB', 'IJAF', 'ILAR', 'ILKL', 'IMLR', 'IPAP', 'IPPH', 'IRFD', 'ISAU', 'ISCM', 'ISKP'];
  for (const icao of measured) {
    const airport = navdata.airports.find((a) => a.icao === icao);
    const w = World.studsToWorld(offsets[icao].x * 100, offsets[icao].y * 100);
    const err = Math.hypot(w.xNm - airport.xNm, w.yNm - airport.yNm);
    assert.ok(err < 0.4, `${icao} is ${err.toFixed(2)} nm off`);
  }
});

test('conversions round-trip, and flat coordinates keep distances exact', () => {
  const back = World.worldToStuds(...Object.values(World.studsToWorld(-4028, 19238)));
  assert.ok(Math.abs(back.x + 4028) < 1e-6 && Math.abs(back.y - 19238) < 1e-6);
  const a = World.worldToFlat(10, 20), b = World.worldToFlat(13, 24);
  const east = (b.lon - a.lon) * 60, north = (b.lat - a.lat) * 60;
  assert.ok(Math.abs(Math.hypot(east, north) - 5) < 1e-9, 'a 3-4-5 triangle stays 5 nm');
  assert.ok(north < 0, 'larger y (south on the grid) is a smaller latitude');
  assert.deepEqual(World.flatToWorld(a.lat, a.lon), { xNm: 10, yNm: 20 });
});

const test2 = require('node:test');
const assert2 = require('node:assert');
const AP = require('../companion/lib/autopilot');
test2('yokePercent scales heading error and clamps', () => {
  assert2.strictEqual(AP.yokePercent(45, 90), 50);
  assert2.strictEqual(AP.yokePercent(-200, 90), -100);
});
test2('yokePulse ignores the deadband and pulses outside it', () => {
  const st = { nextAt: 0 };
  assert2.strictEqual(AP.yokePulse(1, 1000, st), null);
  const p = AP.yokePulse(50, 1000, st);
  assert2.ok(p && p.direction > 0 && p.holdMs > 0);
});

test('companion airports sit where the radar draws them, and calibration + dead reckoning agree on distances', () => {
  const { loadAirports, nearestAirport } = require('../companion/lib/airports');
  const { buildCalibration } = require('../companion/lib/calibration');
  const { integrate } = require('../companion/lib/deadReckoning');
  const { distanceBearingNm } = require('../companion/lib/coords');
  const anchors = require('../data/worldAnchors.json').airports;
  const airports = loadAirports();
  const byIcao = Object.fromEntries(airports.map((a) => [a.icao, a]));
  assert2.ok(byIcao.IRFD && byIcao.IMLR);
  // Distance + bearing between two airports equals what the radar's grid says.
  const d = distanceBearingNm(byIcao.IRFD.world, byIcao.IMLR.world);
  const dx = anchors.IMLR.xNm - anchors.IRFD.xNm, dy = anchors.IMLR.yNm - anchors.IRFD.yNm;
  assert2.ok(Math.abs(d.distanceNm - Math.hypot(dx, dy)) < 0.01);
  // A minimap calibrated on two airports puts a third pixel where the grid says.
  const cal = buildCalibration([{ pixel: { x: 0, y: 0 }, world: byIcao.IRFD.world }, { pixel: { x: 100, y: 0 }, world: byIcao.IMLR.world }]);
  const p = cal.project({ x: 50, y: 0 });
  const mid = distanceBearingNm(byIcao.IRFD.world, p);
  assert2.ok(Math.abs(mid.distanceNm - Math.hypot(dx, dy) / 2) < 0.01);
  // Flying 10 nm east moves the estimate 10 nm east - no cos shrink.
  const moved = integrate({ world: byIcao.IRFD.world, atMs: 0 }, { headingDeg: 90, speedKts: 10, atMs: 3_600_000 });
  const m = distanceBearingNm(byIcao.IRFD.world, moved.world);
  assert2.ok(Math.abs(m.distanceNm - 10) < 0.01 && Math.abs(m.bearingDeg - 90) < 0.1);
  assert2.strictEqual(nearestAirport(airports, byIcao.IRFD.world).icao, 'IRFD');
});
