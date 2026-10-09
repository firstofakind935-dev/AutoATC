// Flat-earth distance/bearing over lat/lon - the same simplification the
// companion app uses (companion/lib/coords.js). The whole PTFS world spans
// about half a degree, so treating it as a flat plane is accurate enough,
// and it keeps the planner's numbers identical to what the companion's FMS
// computes in flight.

const NM_PER_DEG_LAT = 60;
const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

function nmPerDegLon(atLat) {
  return NM_PER_DEG_LAT * Math.cos(toRad(atLat));
}

/** {lat, lon} -> {distanceNm, bearingDeg} (true, 0-360). */
function distanceBearing(from, to) {
  const north = (to.lat - from.lat) * NM_PER_DEG_LAT;
  const east = (to.lon - from.lon) * nmPerDegLon(from.lat);
  let bearingDeg = toDeg(Math.atan2(east, north));
  if (bearingDeg < 0) bearingDeg += 360;
  return { distanceNm: Math.hypot(north, east), bearingDeg };
}

const distanceNm = (a, b) => distanceBearing(a, b).distanceNm;

/** The point `nm` along `bearingDeg` from `from`. */
function project(from, bearingDeg, nm) {
  return {
    lat: from.lat + (nm * Math.cos(toRad(bearingDeg))) / NM_PER_DEG_LAT,
    lon: from.lon + (nm * Math.sin(toRad(bearingDeg))) / nmPerDegLon(from.lat),
  };
}

/** Signed smallest difference a - b in degrees, in (-180, 180]. */
function angleDiff(a, b) {
  let d = (((a - b) % 360) + 360) % 360;
  if (d > 180) d -= 360;
  return d;
}

const normalizeDeg = (deg) => ((deg % 360) + 360) % 360;

module.exports = { NM_PER_DEG_LAT, nmPerDegLon, distanceBearing, distanceNm, project, angleDiff, normalizeDeg };
