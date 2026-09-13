// Parses this repo's chart coordinate format ("N41 48.1  E000 16.1" - degrees
// and decimal minutes) into signed decimal degrees, and does small-area flat
// distance/bearing math. The whole in-game world spans only a couple of
// degrees, so treating lat/lon as flat Cartesian (not spherical) is a
// reasonable simplification here - this is a game map, not real navigation.

const COORD_RE = /([NS])(\d+)\s+([\d.]+)\s+([EW])(\d+)\s+([\d.]+)/;

function parseCoordinates(raw) {
  const m = (raw || '').match(COORD_RE);
  if (!m) return null;
  const [, nsHem, latDeg, latMin, ewHem, lonDeg, lonMin] = m;
  let lat = Number(latDeg) + Number(latMin) / 60;
  let lon = Number(lonDeg) + Number(lonMin) / 60;
  if (nsHem === 'S') lat = -lat;
  if (ewHem === 'W') lon = -lon;
  return { lat, lon };
}

// Nautical miles per degree of latitude is ~60 everywhere; longitude shrinks
// by cos(latitude). Good enough at this scale and this far from the poles.
const NM_PER_DEG_LAT = 60;

function nmPerDegLon(atLat) {
  return NM_PER_DEG_LAT * Math.cos((atLat * Math.PI) / 180);
}

function distanceBearingNm(from, to) {
  const dLat = to.lat - from.lat;
  const dLon = to.lon - from.lon;
  const northNm = dLat * NM_PER_DEG_LAT;
  const eastNm = dLon * nmPerDegLon(from.lat);
  const distanceNm = Math.sqrt(northNm * northNm + eastNm * eastNm);
  let bearingDeg = (Math.atan2(eastNm, northNm) * 180) / Math.PI;
  if (bearingDeg < 0) bearingDeg += 360;
  return { distanceNm, bearingDeg };
}

module.exports = { parseCoordinates, distanceBearingNm, nmPerDegLon, NM_PER_DEG_LAT };
