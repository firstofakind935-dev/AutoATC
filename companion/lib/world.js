// The world grid: nautical miles, x east, y south, origin at the north-west
// corner of the radar's map - the same grid 24SPY's positions and the
// planner's xNm / yNm use. The live aircraft feed reports positions in PTFS
// "studs"; this converts them.
//
// The constants were fitted on the 16 airports whose stud positions were
// measured (every one lands within 0.3 nm of its 24SPY position), which also
// shows the game's own axes are north-up with y growing southward, and that
// one nautical mile is about 3280 studs.
//
// The FMS flies in flat lat/lon, so worldToFlat() turns grid miles into a
// latitude/longitude with exactly 60 nm per degree each way (at latitude 0
// the flat-earth math has no cos() shrink), keeping every distance exact.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.World = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  const NM_PER_STUD = 0.00030488559747884637; // 1 / 3279.92
  const ORIGIN_X_NM = 22.061527459937743;
  const ORIGIN_Y_NM = 15.039210123446306;

  /** PTFS studs {x, y} -> world grid {xNm, yNm}. */
  const studsToWorld = (x, y) => ({ xNm: x * NM_PER_STUD + ORIGIN_X_NM, yNm: y * NM_PER_STUD + ORIGIN_Y_NM });
  const worldToStuds = (xNm, yNm) => ({ x: (xNm - ORIGIN_X_NM) / NM_PER_STUD, y: (yNm - ORIGIN_Y_NM) / NM_PER_STUD });

  /** World grid {xNm, yNm} -> the flat {lat, lon} the FMS uses (60 nm per degree, north = up). */
  const worldToFlat = (xNm, yNm) => ({ lat: -yNm / 60, lon: xNm / 60 });
  const flatToWorld = (lat, lon) => ({ xNm: lon * 60, yNm: -lat * 60 });

  /**
   * A plan with every waypoint on the world grid, as flat coordinates for the FMS - or null when the
   * plan has waypoints without xNm/yNm (a planner without 24SPY positions for them).
   */
  function planToWorld(plan) {
    if (!plan?.waypoints?.every((w) => Number.isFinite(w.xNm) && Number.isFinite(w.yNm))) return null;
    const move = (p) => ({ ...p, ...worldToFlat(p.xNm, p.yNm) });
    return { ...plan, waypoints: plan.waypoints.map(move), frame: 'world' };
  }

  /** Navdata (fixes and airports) in the same flat world coordinates; entries without a world position are dropped. */
  function navdataToWorld(navdata) {
    const keep = (list) => (list || []).filter((p) => Number.isFinite(p.xNm) && Number.isFinite(p.yNm)).map((p) => ({ ...p, ...worldToFlat(p.xNm, p.yNm) }));
    return { ...navdata, fixes: keep(navdata?.fixes), airports: keep(navdata?.airports) };
  }

  return { planToWorld, navdataToWorld, NM_PER_STUD, ORIGIN_X_NM, ORIGIN_Y_NM, studsToWorld, worldToStuds, worldToFlat, flatToWorld };
});
