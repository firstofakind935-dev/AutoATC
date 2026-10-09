// Flight management: holds the imported flight plan, tracks which leg is
// active, and turns the aircraft's tracked position into guidance - the
// heading to fly (LNAV), the altitude and vertical speed to fly (VNAV) and
// the speed to hold. The autopilot (autopilot.js) turns that guidance into
// control inputs; the MCDU/CDU pages (renderer/fms.js) display it.
//
// Plain functions over a plain state object, so the same file runs in the
// FMS window (loaded with a <script> tag) and under node's test runner.
//
// Positions are {lat, lon} in the same flat-earth frame as coords.js and the
// planner (planner/lib/geo.js) - the whole PTFS world is about half a
// degree across, so flat math is accurate enough.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Fms = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  const NM_PER_DEG_LAT = 60;
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const norm = (d) => ((d % 360) + 360) % 360;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // A waypoint counts as passed once the aircraft is this close, plus a
  // little more at speed so the turn to the next leg starts in time.
  const SEQUENCE_BASE_NM = 0.5;
  const SEQUENCE_PER_100KT_NM = 0.15;
  // LNAV intercept: degrees of correction per nm off course, capped at a
  // 30 degree intercept, like a real FMS.
  const INTERCEPT_DEG_PER_NM = 40;
  const MAX_INTERCEPT_DEG = 30;
  // Slow to approach speed this far from the destination.
  const APPROACH_NM = 4;

  function toLocalNm(from, to) {
    return {
      east: (to.lon - from.lon) * NM_PER_DEG_LAT * Math.cos(toRad(from.lat)),
      north: (to.lat - from.lat) * NM_PER_DEG_LAT,
    };
  }

  function distanceBearing(from, to) {
    const { east, north } = toLocalNm(from, to);
    return { distanceNm: Math.hypot(east, north), bearingDeg: norm(toDeg(Math.atan2(east, north))) };
  }

  function angleDiff(a, b) {
    let d = norm(a - b);
    if (d > 180) d -= 360;
    return d;
  }

  /** Fresh FMS state for an imported plan (as served by the planner API). */
  function load(plan) {
    if (!plan?.waypoints?.length || plan.waypoints.length < 2) throw new Error('Plan has no route');
    return {
      plan,
      waypoints: plan.waypoints.map((w) => ({ ident: w.ident, type: w.type, lat: w.lat, lon: w.lon })),
      activeIndex: 1, // the waypoint we're flying TO
      legFrom: { lat: plan.waypoints[0].lat, lon: plan.waypoints[0].lon, ident: plan.waypoints[0].ident },
      cruiseAltFt: plan.profile.cruiseAltFt,
      arrived: false,
    };
  }

  const activeWaypoint = (state) => state.waypoints[state.activeIndex] || null;

  /** Remaining distance along the route from `position`. */
  function distanceToDestination(state, position) {
    const active = activeWaypoint(state);
    if (!active) return 0;
    let total = distanceBearing(position, active).distanceNm;
    for (let i = state.activeIndex + 1; i < state.waypoints.length; i++) {
      total += distanceBearing(state.waypoints[i - 1], state.waypoints[i]).distanceNm;
    }
    return total;
  }

  /**
   * Moves to the next leg once the active waypoint is reached or passed.
   * Returns the waypoint just passed, or null.
   */
  function sequence(state, position, speedKt = 0) {
    const active = activeWaypoint(state);
    if (!active || state.arrived) return null;
    const toActive = distanceBearing(position, active);
    const legTrack = distanceBearing(state.legFrom, active).bearingDeg;
    const threshold = SEQUENCE_BASE_NM + (Math.max(0, speedKt) / 100) * SEQUENCE_PER_100KT_NM;
    // "Passed" = the waypoint is now behind us relative to the leg.
    const passed = Math.abs(angleDiff(toActive.bearingDeg, legTrack)) > 90 && toActive.distanceNm < 3;
    if (toActive.distanceNm > threshold && !passed) return null;

    state.legFrom = { lat: active.lat, lon: active.lon, ident: active.ident };
    if (state.activeIndex >= state.waypoints.length - 1) state.arrived = true;
    else state.activeIndex += 1;
    return active;
  }

  /**
   * DIRECT TO: fly straight from here to `ident`. Uses the plan's own
   * waypoint if it's still ahead; otherwise inserts it from `navdata`
   * ({airports, fixes}) in front of the active waypoint.
   */
  function directTo(state, ident, position, navdata) {
    const wanted = String(ident || '').toUpperCase();
    let index = state.waypoints.findIndex((w, i) => i >= state.activeIndex && w.ident === wanted);
    if (index === -1) {
      const found = navdata && [...(navdata.fixes || []), ...(navdata.airports || []).map((a) => ({ ...a, ident: a.icao, type: 'APT' }))]
        .find((p) => p.ident === wanted);
      if (!found) throw new Error(`NOT IN DATA BASE: ${wanted}`);
      index = state.activeIndex;
      state.waypoints.splice(index, 0, { ident: found.ident, type: found.type, lat: found.lat, lon: found.lon });
    }
    state.activeIndex = index;
    state.legFrom = { lat: position.lat, lon: position.lon, ident: 'PPOS' };
    state.arrived = false;
  }

  /**
   * Guidance for where the aircraft is now. `position` is {lat, lon};
   * `telemetry` is {altFt, speedKt, headingDeg}. Sequences legs as a side
   * effect, so call it every tracking update.
   */
  function guidance(state, position, telemetry = {}) {
    const passed = sequence(state, position, telemetry.speedKt);
    const p = state.plan.profile;
    const active = activeWaypoint(state);
    const toDest = distanceToDestination(state, position);

    // LNAV: course from the leg's start to the active waypoint, corrected
    // back onto it in proportion to the cross-track error.
    let lnav = null;
    if (active && !state.arrived) {
      const legTrack = distanceBearing(state.legFrom, active).bearingDeg;
      const fromStart = toLocalNm(state.legFrom, position);
      const trackRad = toRad(legTrack);
      // Positive = right of course.
      const xtkNm = fromStart.east * Math.cos(trackRad) - fromStart.north * Math.sin(trackRad);
      const toActive = distanceBearing(position, active);
      const correction = clamp(-xtkNm * INTERCEPT_DEG_PER_NM, -MAX_INTERCEPT_DEG, MAX_INTERCEPT_DEG);
      lnav = {
        desiredTrackDeg: Math.round(legTrack),
        xtkNm,
        headingDeg: Math.round(norm(legTrack + correction)),
        toIdent: active.ident,
        toDistanceNm: toActive.distanceNm,
        toBearingDeg: toActive.bearingDeg,
      };
    }

    // VNAV: climb to cruise, then follow the descent path down to the
    // destination - feet per nm from the plan's descent rate and speed.
    const ftPerNm = (p.descentFpm * 60) / p.descentKt;
    const pathAltFt = p.destElevFt + toDest * ftPerNm;
    const targetAltFt = Math.round(Math.min(state.cruiseAltFt, pathAltFt) / 10) * 10;
    const alt = typeof telemetry.altFt === 'number' ? telemetry.altFt : null;

    let phase;
    if (state.arrived) phase = 'DONE';
    else if (toDest <= APPROACH_NM) phase = 'APP';
    else if (pathAltFt < state.cruiseAltFt && (alt === null || alt > pathAltFt - 300)) phase = 'DES';
    else if (alt !== null && alt < state.cruiseAltFt - 300) phase = 'CLB';
    else phase = 'CRZ';

    const speedKt = { CLB: p.climbKt, CRZ: p.cruiseKt, DES: p.descentKt, APP: p.approachKt, DONE: p.approachKt }[phase];
    const verticalSpeedFpm = phase === 'CLB' ? p.climbFpm : phase === 'DES' || phase === 'APP' ? -p.descentFpm : 0;

    return {
      passed: passed ? passed.ident : null,
      phase,
      lnav,
      vnav: { targetAltFt, verticalSpeedFpm, pathAltFt: Math.round(pathAltFt) },
      speedKt,
      distanceToDestNm: toDest,
      // Minutes to go at the current speed (or the plan's cruise speed).
      eteMin: (toDest / Math.max(60, telemetry.speedKt || p.cruiseKt)) * 60,
    };
  }

  return { load, guidance, sequence, directTo, activeWaypoint, distanceToDestination, distanceBearing, angleDiff };
});
