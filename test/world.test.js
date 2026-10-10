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
