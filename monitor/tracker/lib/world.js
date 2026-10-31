// The world grid: nautical miles, x east, y south, origin at the north-west
// corner of the radar's map - the same grid 24SPY's positions and the
// planner's xNm / yNm use. The live aircraft feed and the ground charts give
// positions in PTFS "studs" (the 24RC / 24Radar chart unit is 100 studs);
// this converts them.
//
// The transform is fitted on the islands themselves: 24RC's coast.svg is
// drawn in exact game coordinates, and 11 island centroids land on the radar
// picture's islands within 3-60 m. It is a similarity (scale, a 0.03 degree
// turn, shift); one nautical mile is about 3260 studs. (The older airport-
// point fit was off by 0.3-0.45 nm, which put stands on the wrong taxiway.)
//
// The FMS flies in flat lat/lon, so worldToFlat() turns grid miles into a
// latitude/longitude with exactly 60 nm per degree each way (at latitude 0
// the flat-earth math has no cos() shrink), keeping every distance exact.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.World = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  // xNm = A*x - B*y + ORIGIN_X_NM, yNm = B*x + A*y + ORIGIN_Y_NM, x/y in studs. Keep in step with
  // data/gameFrame.json (the radars and the Python tracker read that).
  const A = 0.00030675641063886483;
  const B = 1.609052091551345e-7;
  const ORIGIN_X_NM = 21.731369781953834;
  const ORIGIN_Y_NM = 14.790667919876864;
  const NM_PER_STUD = Math.hypot(A, B);

  /** PTFS studs {x, y} -> world grid {xNm, yNm}. */
  const studsToWorld = (x, y) => ({ xNm: A * x - B * y + ORIGIN_X_NM, yNm: B * x + A * y + ORIGIN_Y_NM });
  const worldToStuds = (xNm, yNm) => {
    const dx = xNm - ORIGIN_X_NM, dy = yNm - ORIGIN_Y_NM, d = A * A + B * B;
    return { x: (A * dx + B * dy) / d, y: (A * dy - B * dx) / d };
  };

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
