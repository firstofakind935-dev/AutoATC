const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPlan } = require('../planner/lib/plan');
const { listProcedures, expandSid, expandStar, expandApproach } = require('../planner/lib/procedures');
const { findAirport, findFix } = require('../planner/lib/navdata');
const { distanceNm } = require('../planner/lib/geo');

const base = { callsign: 'N42Y', aircraftType: 'A320' };

test('every IRFD procedure fix has a position, or is reported as unplaced', () => {
  const list = listProcedures('IRFD');
  assert.ok(list.sids.length >= 7 && list.stars.length >= 9 && list.approaches.length >= 7);
  for (const p of [...list.sids, ...list.stars, ...list.approaches]) {
    for (const name of p.unplaced) assert.ok(!findFix(name), `${name} is reported unplaced but exists`);
  }
  // the departures use only fixes that 24SPY has
  for (const sid of list.sids) assert.deepEqual(sid.unplaced, [], sid.name);
});

test('SID fixes are placed near the airport they depart', () => {
  const irfd = findAirport('IRFD');
  for (const [name, rwy] of [['DARRK3', '25L'], ['LOGAN4', '25C'], ['OSHNN1', '25R'], ['WNNDY3', '25L'], ['TRN1', '25C']]) {
    const sid = expandSid('IRFD', name, rwy);
    assert.ok(sid.fixes.length >= 2, name);
    for (const f of sid.fixes) assert.ok(distanceNm(irfd, f) < 20, `${name} ${f.ident} is ${distanceNm(irfd, f).toFixed(1)} nm away`);
  }
});

test('altitude restrictions carry through', () => {
  const sid = expandSid('IRFD', 'DARRK3', '25L');
  assert.equal(sid.fixes.find((f) => f.ident === 'DOCKR').altMinFt, 1000);
  assert.equal(sid.fixes.find((f) => f.ident === 'DARRK').altMinFt, 3000);
  assert.equal(expandStar('IRFD', 'SUNST3', '25L').fixes.find((f) => f.ident === 'SWEET').altMaxFt, 1500);
});

test('a runway a procedure is not published for is refused, with the valid ones listed', () => {
  assert.throws(() => expandSid('IRFD', 'OSHNN1', '7L'), /not published for runway 7L.*25C, 25L, 25R/);
  assert.throws(() => expandStar('IRFD', 'KUNAV2', '25L', 'WELSH'), /entered from KENED/);
  assert.throws(() => expandApproach('IRFD', 'ILS OR LOC RWY 25L', 'KENED'), /starts from/);
});

test('a plan with SID, STAR and approach flies them in order, once each', () => {
  const plan = buildPlan({ ...base, origin: 'ITKO', destination: 'IRFD', star: 'KUNAV2', arrRunway: '25L', starEntry: 'KENED', approach: 'ILS OR LOC RWY 25L', approachIaf: 'SWEET' });
  const ids = plan.waypoints.map((w) => w.ident);
  assert.deepEqual(ids.slice(ids.indexOf('KENED')), ['KENED', 'KUNAV', 'HAWFA', 'SWEET', 'FISSK', 'COTAF', 'BACHE', 'IRFD']);
  assert.match(plan.route, /STAR KUNAV2\/25L APP ILS OR LOC RWY 25L/);
  assert.ok(plan.warnings.some((w) => /radar vectors/.test(w)));
  const dep = buildPlan({ ...base, origin: 'IRFD', destination: 'ITKO', sid: 'KENED2', depRunway: '25C' });
  assert.deepEqual(dep.waypoints.slice(0, 3).map((w) => w.ident), ['IRFD', 'KUNAV', 'KENED']);
  assert.equal(dep.waypoints[2].altMinFt, 3000);
});

test('fixes with no position are skipped and flagged, not invented', () => {
  const plan = buildPlan({ ...base, origin: 'IPPH', destination: 'IRFD', star: 'GORDO1', arrRunway: '7L' });
  assert.ok(plan.warnings.some((w) => /no position for MOSSY, GORDO/.test(w)));
  assert.ok(!plan.waypoints.some((w) => w.ident === 'GORDO'));
});

test('a plan without procedures is unchanged', () => {
  const plan = buildPlan({ ...base, origin: 'IRFD', destination: 'ITKO' });
  assert.equal(plan.procedures, undefined);
});
