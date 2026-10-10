const test = require('node:test');
const assert = require('node:assert');
const { pictureToGame } = require('../companion/lib/frames');
const { standFix } = require('../companion/lib/stands');

test('a picture-frame fix at ITKO stand 22 is carried to the stand', () => {
  // What the radar showed for N42Y parked at ITKO stand 22 (a map fix, on the picture): 19.30, 5.05.
  const stand = standFix('ITKO', '22'); // with ITKO's shipped nudge: where the real stand is on the map
  const raw = pictureToGame(19.3, 5.05);
  assert.ok(Math.hypot(raw.xNm - stand.xNm, raw.yNm - stand.yNm) < 0.12, `${raw.xNm}, ${raw.yNm} vs ${stand.xNm}, ${stand.yNm}`);
  assert.strictEqual(raw.icao, 'ITKO');
});

test('far from any airport nothing is shifted, and big shipped offsets are not used', () => {
  const far = pictureToGame(2, 2);
  assert.strictEqual(far.dxNm, 0);
  assert.strictEqual(far.dyNm, 0);
  // IPPH's shipped offset is ~1.5 nm - too big to trust, so a fix right there is left alone
  const ipph = pictureToGame(27.27 + 1.2, 8.57 + 0.9);
  assert.ok(Math.hypot(ipph.dxNm, ipph.dyNm) < 0.5);
});

test('a pilot calibration overrides the shipped offset', () => {
  const mine = pictureToGame(19.3, 5.05, { ITKO: { dxNm: 0.1, dyNm: -0.1 } });
  assert.ok(Math.abs(mine.dxNm - 0.1) < 0.02 && Math.abs(mine.dyNm + 0.1) < 0.02);
  const ipph = pictureToGame(28.47, 9.47, { IPPH: { dxNm: -1.2, dyNm: -0.9 } }); // the picture shows IPPH at 28.47, 9.47
  assert.ok(Math.abs(ipph.dxNm + 1.2) < 0.15);
});
