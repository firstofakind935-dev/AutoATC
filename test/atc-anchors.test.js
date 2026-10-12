const test = require('node:test');
const assert = require('node:assert');
const { anchorFrom } = require('../src/atc/flightStrips');
const { runwayFix } = require('../companion/lib/runways');
const { standFix } = require('../companion/lib/stands');

test('a STRIP clearance with a stand, a taxi route or a line-up becomes a position anchor', () => {
  assert.deepStrictEqual(
    { ...anchorFrom({ stand: 'Stand 12' }, 'irfd'), at: 0 },
    { kind: 'stand', airport: 'IRFD', stand: '12', at: 0 },
  );
  const lineup = anchorFrom({ lineUpRunway: '25l', squawk: '4253' }, 'IRFD');
  assert.strictEqual(lineup.kind, 'lineup');
  assert.strictEqual(lineup.runway, '25L');
  const taxi = anchorFrom({ taxiRoute: 'A K', departureRunway: '25l' }, 'IRFD');
  assert.deepStrictEqual([taxi.kind, taxi.route, taxi.runway], ['taxi', 'A K', '25L']);
  assert.strictEqual(anchorFrom({ squawk: '1234' }, 'IRFD'), null);
});

test('line-up puts the aircraft just past the threshold, pointing down the runway', () => {
  const r = runwayFix('IRFD', '25L');
  assert.strictEqual(r.headingDeg, 247);
  // 25L and 7R are the two ends of one runway: about 0.6 nm apart, 25L at the east end
  const other = runwayFix('IRFD', '7R');
  const len = Math.hypot(r.xNm - other.xNm, r.yNm - other.yNm);
  assert.ok(len > 0.5 && len < 0.75, String(len));
  assert.ok(r.xNm > other.xNm);
  assert.match(runwayFix('IRFD', '9').error, /no runway 9/);
  assert.strictEqual(runwayFix('IRFD', 'RWY 07R').runway, '7R');
  // runways and stands share the airport's chart-to-map nudge, so both sit on the same map
  const stand = standFix('IRFD', '12');
  assert.ok(Math.hypot(stand.xNm - r.xNm, stand.yNm - r.yNm) < 1.5);
});
