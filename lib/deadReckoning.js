// Continuous position estimator: integrates heading + groundspeed over
// elapsed time from a last known fix. This is the primary estimator - it
// works regardless of how the in-game minimap behaves (recentering on the
// player vs. staying put until manually panned/zoomed), since it never
// depends on minimap pixels at all. The minimap is only used to set/correct
// the fix this integrates from (see calibration.js) - drift grows with time
// since that last fix, which is why periodic corrections matter.
//
// Flat-Cartesian approximation (same simplification as coords.js) - fine at
// this map's scale.

const { NM_PER_DEG_LAT, nmPerDegLon } = require('./coords');

/**
 * fix: { world: {lat, lon}, atMs: number } - the last known position and
 * when it was true (either a fresh minimap correction, or a previous
 * dead-reckoning estimate being carried forward).
 * sample: { headingDeg: number, speedKts: number, atMs: number } - the most
 * recent HUD reading.
 * Returns a new { world: {lat, lon}, atMs } estimate.
 */
function integrate(fix, sample) {
  const elapsedHours = (sample.atMs - fix.atMs) / 3_600_000;
  if (elapsedHours <= 0) return fix;

  const distanceNm = sample.speedKts * elapsedHours;
  const headingRad = (sample.headingDeg * Math.PI) / 180;
  const northNm = distanceNm * Math.cos(headingRad);
  const eastNm = distanceNm * Math.sin(headingRad);

  const lat = fix.world.lat + northNm / NM_PER_DEG_LAT;
  const lon = fix.world.lon + eastNm / nmPerDegLon(fix.world.lat);

  return { world: { lat, lon }, atMs: sample.atMs };
}

/**
 * Confidence is just "how long since we last had a real fix" - the bot-side
 * context (src/atc/positions.js) uses this to word the estimate
 * appropriately (or drop it) rather than presenting stale dead reckoning as
 * if it were a fresh minimap read.
 */
function ageMs(fix, nowMs) {
  return nowMs - fix.atMs;
}

module.exports = { integrate, ageMs };
