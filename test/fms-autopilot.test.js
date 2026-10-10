const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPlan } = require('../planner/lib/plan');
const Fms = require('../companion/lib/fms');
const Autopilot = require('../companion/lib/autopilot');

// --- FMS --------------------------------------------------------------------

test('a fresh plan is flying to its first waypoint after the origin', () => {
  const plan = buildPlan({ callsign: 'T1', aircraftType: 'A320', origin: 'IRFD', destination: 'ITKO' });
  const fms = Fms.load(plan);
  assert.equal(Fms.activeWaypoint(fms).ident, plan.waypoints[1].ident);
});

test('waypoints sequence when reached, and the last one marks arrival', () => {
  const plan = buildPlan({ callsign: 'T1', aircraftType: 'A320', origin: 'IRFD', destination: 'ITKO' });
  const fms = Fms.load(plan);
  for (const wpt of plan.waypoints.slice(1)) {
    assert.equal(Fms.sequence(fms, { lat: wpt.lat, lon: wpt.lon }, 250).ident, wpt.ident);
  }
  assert.equal(fms.arrived, true);
});

test('LNAV steers back toward the course when off to one side', () => {
  const plan = buildPlan({ callsign: 'T1', aircraftType: 'A320', origin: 'ISAU', destination: 'IZOL' });
  const fms = Fms.load(plan);
  const from = plan.waypoints[0];
  const g = Fms.guidance(fms, { lat: from.lat + 0.01, lon: from.lon }, { altFt: 2000, speedKt: 250 });
  // Course is roughly east; 0.6 nm north of it means steer right (south of the track).
  assert.ok(g.lnav.xtkNm < 0, 'north of an eastbound course is left of it');
  assert.ok(Fms.angleDiff(g.lnav.headingDeg, g.lnav.desiredTrackDeg) > 0, 'correction turns right');
});

test('VNAV climbs to cruise, then descends on the path', () => {
  const plan = buildPlan({ callsign: 'T1', aircraftType: 'A320', origin: 'IRFD', destination: 'ITKO', cruiseAltFt: 4000 });
  const fms = Fms.load(plan);
  const start = plan.waypoints[0];
  const climb = Fms.guidance(fms, { lat: start.lat, lon: start.lon }, { altFt: 500, speedKt: 200 });
  assert.equal(climb.phase, 'CLB');
  assert.equal(climb.vnav.targetAltFt, 4000);
  // Fly the plan down to its last leg, then check just short of the end.
  for (const wpt of plan.waypoints.slice(1, -1)) Fms.sequence(fms, { lat: wpt.lat, lon: wpt.lon }, 250);
  const dest = plan.waypoints[plan.waypoints.length - 1];
  const near = Fms.guidance(fms, { lat: dest.lat - 0.08, lon: dest.lon }, { altFt: 4000, speedKt: 300 });
  assert.ok(near.vnav.targetAltFt < 4000, 'below cruise on the descent path');
});

test('DIRECT TO a waypoint not in the plan inserts it ahead', () => {
  const plan = buildPlan({ callsign: 'T1', aircraftType: 'A320', origin: 'IRFD', destination: 'ITKO' });
  const fms = Fms.load(plan);
  const navdata = require('../planner/data/navdata.json');
  const fix = navdata.fixes.find((f) => !plan.waypoints.some((w) => w.ident === f.ident));
  Fms.directTo(fms, fix.ident, { lat: plan.waypoints[0].lat, lon: plan.waypoints[0].lon }, navdata);
  assert.equal(Fms.activeWaypoint(fms).ident, fix.ident);
  assert.equal(fms.legFrom.ident, 'PPOS');
  assert.throws(() => Fms.directTo(fms, 'NOPE1', { lat: 0, lon: 0 }, navdata), /NOT IN DATA BASE/);
});

// --- Autopilot --------------------------------------------------------------

test('autopilot does nothing until it has two samples, and nothing when disengaged', () => {
  const ap = Autopilot.create();
  ap.selected.headingDeg = 90;
  assert.deepEqual(Autopilot.update(ap, { headingDeg: 0, altFt: 3000, speedKt: 250, atMs: 0 }, null, 0).commands, []);
  assert.deepEqual(Autopilot.update(ap, { headingDeg: 0, altFt: 3000, speedKt: 250, atMs: 3000 }, null, 3000).commands, []);
  ap.engaged = true;
  const out = Autopilot.update(ap, { headingDeg: 0, altFt: 3000, speedKt: 250, atMs: 6000 }, null, 6000);
  assert.deepEqual(out.commands.map((c) => [c.axis, c.direction]), [['roll', 1]]);
});

test('autopilot disconnects itself when tracking data stops', () => {
  const ap = Autopilot.create();
  ap.engaged = true;
  Autopilot.update(ap, { headingDeg: 0, altFt: 3000, speedKt: 250, atMs: 0 }, null, 0);
  const out = Autopilot.update(ap, null, null, 31000);
  assert.equal(out.disconnected, true);
  assert.equal(ap.engaged, false);
});

test('VNAV never climbs through the altitude selected on the panel', () => {
  const ap = Autopilot.create();
  ap.vertical = 'VNAV';
  ap.selected.altFt = 3000;
  const tg = Autopilot.targets(ap, { vnav: { targetAltFt: 9000, verticalSpeedFpm: 2000 } });
  assert.equal(tg.altFt, 3000);
});

// --- Closed loop: autopilot + FMS flying a simple simulated aircraft ---------
//
// Not PTFS - a rough stand-in so the control logic is exercised end to end:
// holding a roll key changes bank, pitch changes vertical speed, throttle
// changes thrust. The autopilot only sees heading/altitude/speed every 3 s,
// rounded like the HUD, exactly what the companion app gives it.

function simulateFlight(plan, { seconds = 1200, sampleEveryS = 3 } = {}) {
  const KEY_RATES = { roll: 20, pitch: 1500, throttle: 0.25 }; // per second held
  const g = 9.81;
  const start = plan.waypoints[0];
  const sim = { lat: start.lat, lon: start.lon, hdg: 0, bank: 0, alt: 1000, vs: 0, speed: 220, throttle: 0.6 };
  const holds = { roll: 0, pitch: 0, throttle: 0 }; // signed seconds left

  const fms = Fms.load(plan);
  const ap = Autopilot.create();
  Object.assign(ap, { engaged: true, autothrottle: true, lateral: 'LNAV', vertical: 'VNAV', speedMode: 'MANAGED' });
  ap.selected.altFt = plan.profile.cruiseAltFt;

  let maxXtk = 0;
  let maxAltOverCruise = 0;
  const dt = 0.1;
  for (let t = 0; t < seconds; t += dt) {
    for (const axis of Object.keys(holds)) {
      if (!holds[axis]) continue;
      const step = Math.sign(holds[axis]) * Math.min(dt, Math.abs(holds[axis]));
      if (axis === 'roll') sim.bank = Math.max(-35, Math.min(35, sim.bank + step * KEY_RATES.roll));
      if (axis === 'pitch') sim.vs = Math.max(-4000, Math.min(4000, sim.vs + step * KEY_RATES.pitch));
      if (axis === 'throttle') sim.throttle = Math.max(0, Math.min(1, sim.throttle + step * KEY_RATES.throttle));
      holds[axis] -= step;
      if (Math.abs(holds[axis]) < 1e-9) holds[axis] = 0;
    }
    const turnRate = ((g * Math.tan((sim.bank * Math.PI) / 180)) / (sim.speed * 0.5144)) * (180 / Math.PI);
    sim.hdg = (((sim.hdg + turnRate * dt) % 360) + 360) % 360;
    sim.alt += (sim.vs / 60) * dt;
    sim.speed += (sim.throttle * 500 - sim.speed - sim.vs / 100) * 0.05 * dt;
    const nm = (sim.speed / 3600) * dt;
    sim.lat += (nm * Math.cos((sim.hdg * Math.PI) / 180)) / 60;
    sim.lon += (nm * Math.sin((sim.hdg * Math.PI) / 180)) / (60 * Math.cos((sim.lat * Math.PI) / 180));

    const tick = Math.round(t * 10);
    if (tick % (sampleEveryS * 10) !== 0) continue;
    const sample = { headingDeg: Math.round(sim.hdg), altFt: Math.round(sim.alt / 10) * 10, speedKt: Math.round(sim.speed), atMs: tick * 100 };
    const guidance = Fms.guidance(fms, { lat: sim.lat, lon: sim.lon }, sample);
    if (fms.arrived) return { arrived: true, maxXtk, maxAltOverCruise, minutes: t / 60, sim };
    if (guidance.lnav && fms.activeIndex > 1) maxXtk = Math.max(maxXtk, Math.abs(guidance.lnav.xtkNm));
    maxAltOverCruise = Math.max(maxAltOverCruise, sim.alt - plan.profile.cruiseAltFt);
    for (const c of Autopilot.update(ap, sample, guidance, sample.atMs).commands) holds[c.axis] = (c.direction * c.ms) / 1000;
  }
  return { arrived: false, maxXtk, maxAltOverCruise, minutes: seconds / 60, sim };
}

for (const [origin, destination, type] of [['IRFD', 'ITKO', 'A320'], ['ISAU', 'IZOL', 'B738'], ['IPPH', 'ILAR', 'E190']]) {
  test(`closed loop: autopilot flies ${type} ${origin} -> ${destination} along the route`, () => {
    const plan = buildPlan({ callsign: 'SIM1', aircraftType: type, origin, destination, cruiseAltFt: 5000 });
    const result = simulateFlight(plan);
    assert.ok(result.arrived, `did not reach ${destination} (ended at ${JSON.stringify(result.sim)})`);
    assert.ok(result.maxXtk < 1.5, `wandered ${result.maxXtk.toFixed(2)} nm off the route`);
    assert.ok(result.maxAltOverCruise < 600, `overshot cruise by ${Math.round(result.maxAltOverCruise)} ft`);
  });
}

// --- Mouse steering (PTFS flies pitch and bank by mouse) ---------------------

const { createMouseSteer } = require('../companion/lib/mouseSteer');

function fakeMouse() {
  const io = { cursor: { x: 0, y: 0 }, t: 0, timers: [], moves: [] };
  io.moveMouse = (x, y) => {
    io.cursor = { x, y };
    io.moves.push([x, y]);
  };
  io.getCursor = () => io.cursor;
  io.now = () => io.t;
  io.setTimer = (fn, ms) => {
    const timer = { fn, at: io.t + ms };
    io.timers.push(timer);
    return timer;
  };
  io.clearTimer = (timer) => {
    io.timers = io.timers.filter((t) => t !== timer);
  };
  io.advance = (ms) => {
    io.t += ms;
    for (const timer of io.timers.filter((t) => t.at <= io.t).sort((a, b) => a.at - b.at)) {
      io.timers = io.timers.filter((t) => t !== timer);
      timer.fn();
    }
  };
  return io;
}

const CENTER = { x: 960, y: 540 };

test('mouse nudge: bank right + nose up moves the cursor right and up, then back to center axis by axis', () => {
  const io = fakeMouse();
  const steer = createMouseSteer(io);
  steer.steer({ center: CENTER, deflectionPx: 100, roll: { direction: 1, ms: 100 }, pitch: { direction: 1, ms: 300 } });
  assert.deepEqual(io.cursor, { x: 1060, y: 440 });
  io.advance(100);
  assert.deepEqual(io.cursor, { x: 960, y: 440 }, 'roll nudge ends first');
  io.advance(200);
  assert.deepEqual(io.cursor, CENTER, 'back at center');
});

test('mouse nudge: invertPitch flips the vertical direction', () => {
  const io = fakeMouse();
  createMouseSteer(io).steer({ center: CENTER, deflectionPx: 50, invertPitch: true, pitch: { direction: 1, ms: 100 } });
  assert.deepEqual(io.cursor, { x: 960, y: 590 });
});

test('moving the mouse yourself is reported as an override, and nothing moves', () => {
  const io = fakeMouse();
  const steer = createMouseSteer(io);
  steer.steer({ center: CENTER, deflectionPx: 100, roll: { direction: -1, ms: 100 } });
  io.advance(100); // cursor back at center
  io.cursor = { x: 400, y: 300 }; // the pilot grabs the mouse
  const moves = io.moves.length;
  assert.equal(steer.steer({ center: CENTER, deflectionPx: 100, roll: { direction: 1, ms: 100 } }).override, true);
  assert.equal(io.moves.length, moves);
});

// --- altitude restrictions from procedures ---------------------------------

test('an "at or above" departure restriction is a floor, and an "at" restriction caps the path', () => {
  const plan = buildPlan({ callsign: 'T1', aircraftType: 'A320', origin: 'IRFD', destination: 'ITKO', cruiseAltFt: 5000, sid: 'DARRK3', depRunway: '25L' });
  const fms = Fms.load(plan);
  assert.equal(fms.waypoints.find((w) => w.ident === 'DOCKR').altMinFt, 1000, 'restrictions survive loading the plan');
  const start = plan.waypoints[0];
  const g = Fms.guidance(fms, { lat: start.lat, lon: start.lon }, { altFt: 20, speedKt: 150 });
  assert.equal(g.phase, 'CLB');
  assert.equal(g.vnav.targetAltFt, 5000);
});

test('a descent is held to an "at" restriction: down to it by the fix, not before', () => {
  const plan = buildPlan({ callsign: 'T1', aircraftType: 'A320', origin: 'IPPH', destination: 'IRFD', cruiseAltFt: 6000, star: 'JAMSI1', arrRunway: '7L' });
  const fms = Fms.load(plan);
  const pepul = fms.waypoints.find((w) => w.ident === 'PEPUL');
  assert.equal(pepul.altAtFt, 1300);
  const ftPerNm = (plan.profile.descentFpm * 60) / plan.profile.descentKt;
  // standing on the leg's start the path must already respect 1300 at PEPUL
  Fms.directTo(fms, 'PEPUL', { lat: pepul.lat + 0.1, lon: pepul.lon }, null);
  const g = Fms.guidance(fms, { lat: pepul.lat + 0.1, lon: pepul.lon }, { altFt: 6000, speedKt: 250 });
  const nm = Fms.distanceBearing({ lat: pepul.lat + 0.1, lon: pepul.lon }, pepul).distanceNm;
  assert.ok(g.vnav.targetAltFt <= Math.round((1300 + nm * ftPerNm) / 10) * 10 + 10, `target ${g.vnav.targetAltFt}`);
  assert.deepEqual({ ident: g.vnav.constraint.ident, kind: g.vnav.constraint.kind }, { ident: 'PEPUL', kind: 'AT' });
  // 1 nm short of PEPUL the target is essentially 1300
  const close = Fms.guidance(fms, { lat: pepul.lat + 1 / 60, lon: pepul.lon }, { altFt: 2000, speedKt: 200 });
  assert.ok(close.vnav.targetAltFt <= 1300 + Math.ceil(ftPerNm) + 10, `target ${close.vnav.targetAltFt}`);
});

test('an "at or above" restriction ahead lifts the target and calls for a climb', () => {
  const fms = Fms.load(buildPlan({ callsign: 'T1', aircraftType: 'A320', origin: 'IRFD', destination: 'ITKO', cruiseAltFt: 5000, sid: 'DARRK3', depRunway: '25C' }));
  const aloha = fms.waypoints.find((w) => w.ident === 'ALOHA');
  assert.equal(aloha.altMinFt, 2500);
  Fms.directTo(fms, 'ALOHA', { lat: aloha.lat - 0.05, lon: aloha.lon }, null);
  // still on the ground: the nearest floor (2500 at ALOHA) must show as the shaping limit
  const g = Fms.guidance(fms, { lat: aloha.lat - 0.05, lon: aloha.lon }, { altFt: 100, speedKt: 160 });
  assert.equal(g.phase, 'CLB');
  assert.ok(g.vnav.targetAltFt >= 2500);
});

// --- speed restriction -------------------------------------------------------

test('speed is held to 250 kt or less below 3000 ft, and released above it', () => {
  const plan = buildPlan({ callsign: 'T1', aircraftType: 'A320', origin: 'IRFD', destination: 'ITKO', cruiseAltFt: 5000 });
  assert.ok(plan.profile.climbKt > 250, 'the A320 climbs faster than 250, so the limit matters');
  const fms = Fms.load(plan);
  const start = plan.waypoints[0];
  const at = { lat: start.lat, lon: start.lon };
  const low = Fms.guidance(fms, at, { altFt: 1200, speedKt: 200 });
  assert.equal(low.speedKt, 250);
  assert.equal(low.speedLimited, true);
  const high = Fms.guidance(fms, at, { altFt: 3600, speedKt: 250 });
  assert.equal(high.speedKt, plan.profile.climbKt);
  assert.equal(high.speedLimited, false);
  // just under 3000 on the way back down: limited again, but not flipping at the line
  assert.equal(Fms.guidance(fms, at, { altFt: 3050, speedKt: 250 }).speedLimited, false, 'stays released between 3000 and 3100');
  assert.equal(Fms.guidance(fms, at, { altFt: 2900, speedKt: 250 }).speedLimited, true);
  assert.equal(Fms.guidance(fms, at, { altFt: 3050, speedKt: 250 }).speedLimited, true, 'stays limited until 3100');
});

test('aircraft already slower than 250 are unaffected', () => {
  const plan = buildPlan({ callsign: 'T1', aircraftType: 'DH8D', origin: 'IRFD', destination: 'ITKO', cruiseAltFt: 5000 });
  const fms = Fms.load(plan);
  const g = Fms.guidance(fms, { lat: plan.waypoints[0].lat, lon: plan.waypoints[0].lon }, { altFt: 100, speedKt: 150 });
  assert.equal(g.speedKt, plan.profile.climbKt);
  assert.equal(g.speedLimited, false);
});

test('auto-throttle pulls back harder when too fast than it adds thrust when too slow', () => {
  const ap = Autopilot.create();
  ap.engaged = false; ap.autothrottle = true; ap.speedMode = 'SEL'; ap.selected.speedKt = 250;
  const feed = (speed) => {
    ap.last = null;
    Autopilot.update(ap, { headingDeg: 90, altFt: 5000, speedKt: speed, atMs: 1000 }, null, 1000);
    return Autopilot.update(ap, { headingDeg: 90, altFt: 5000, speedKt: speed, atMs: 4000 }, null, 4000).commands.find((c) => c.axis === 'throttle');
  };
  const slow = feed(230); // 20 kt under: more thrust
  const fast = feed(270); // 20 kt over: less thrust
  assert.equal(slow.direction, 1);
  assert.equal(fast.direction, -1);
  assert.ok(fast.ms > slow.ms, `${fast.ms} ms vs ${slow.ms} ms`);
  assert.ok(feed(330).ms <= Autopilot.DEFAULT_TUNING.maxDecelPulseMs);
  assert.ok(slow.ms <= Autopilot.DEFAULT_TUNING.maxPulseMs);
});

test('the slow-down starts early: above 3000 ft on the way down, and before the final approach', () => {
  const plan = buildPlan({ callsign: 'T1', aircraftType: 'A320', origin: 'IRFD', destination: 'ITKO', cruiseAltFt: 8000 });
  const dest = plan.waypoints[plan.waypoints.length - 1];
  // 10 nm out on the last leg, a little above the descent path: in the descent
  const onLastLeg = () => {
    const fms = Fms.load(plan);
    fms.activeIndex = fms.waypoints.length - 1;
    fms.legFrom = { lat: dest.lat - 0.5, lon: dest.lon, ident: 'X' };
    return fms;
  };
  const tenOut = { lat: dest.lat - 10 / 60, lon: dest.lon };
  const early = Fms.guidance(onLastLeg(), tenOut, { altFt: 4300, speedKt: 310 });
  assert.equal(early.phase, 'DES');
  assert.ok(early.speedKt <= 250, `slowing already, while still 1300 ft above the 3000 ft line (${early.speedKt})`);
  assert.equal(early.anticipating, true);
  // the same altitude and speed while climbing is not limited early
  const climb = Fms.guidance(Fms.load(plan), { lat: plan.waypoints[0].lat, lon: plan.waypoints[0].lon }, { altFt: 4300, speedKt: 250 });
  assert.equal(climb.speedKt, plan.profile.climbKt);
  // approach speed is targeted before the 4 nm point when going fast, not only at it
  const sixOut = Fms.guidance(onLastLeg(), { lat: dest.lat - 6 / 60, lon: dest.lon }, { altFt: 2500, speedKt: 250 });
  assert.equal(sixOut.speedKt, plan.profile.approachKt);
  assert.equal(sixOut.anticipating, true);
  // slow already: nothing to anticipate
  assert.equal(Fms.guidance(onLastLeg(), tenOut, { altFt: 4300, speedKt: 200 }).anticipating, false);
});
