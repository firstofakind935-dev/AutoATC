const { makeLogger } = require('../utils/logger');

const logger = makeLogger('positions');

const CACHE_TTL_MS = 5_000; // short-lived: many bots may request this per pilot transmission

let cache = { text: null, expiresAt: 0 };
let inFlight = null;

/**
 * Formats one row from the monitor's /api/positions into a context line.
 * `position` is deliberately open-shaped (see monitor/server.js) since the
 * companion app's exact estimate format depends on how the game's minimap
 * turns out to behave - this renders whichever fields are actually present.
 */
// Position is estimated primarily by dead reckoning (heading/speed
// integrated since the last minimap correction) - fixAgeSec is how long
// since that last correction, so a stale estimate can be worded with
// appropriate (dis)trust instead of stated as flatly as a fresh one.
function stalenessNote(fixAgeSec) {
  if (typeof fixAgeSec !== 'number') return null;
  if (fixAgeSec < 60) return null; // recent enough to not caveat further
  if (fixAgeSec < 300) return 'estimate a few minutes stale, treat as approximate';
  return 'estimate is stale (5+ min since last correction) - confirm with the pilot before vectoring off this';
}

function formatRow(row) {
  if (!row || !row.callsign || !row.position) return null;
  const p = row.position;
  const parts = [];

  if (typeof p.distanceNm === 'number' && typeof p.bearingDeg === 'number' && p.referenceAirport) {
    parts.push(`${p.distanceNm}nm, bearing ${p.bearingDeg}° from ${p.referenceAirport}`);
  } else if (typeof p.lat === 'number' && typeof p.lon === 'number') {
    parts.push(`lat ${p.lat.toFixed(3)}, lon ${p.lon.toFixed(3)}`);
  }
  if (typeof p.altitudeFt === 'number') parts.push(`${p.altitudeFt}ft`);
  if (typeof p.headingDeg === 'number') parts.push(`heading ${p.headingDeg}°`);
  if (row.aircraftType) parts.push(row.aircraftType);
  if (typeof row.speed === 'number') parts.push(`${row.speed}kts`);

  const staleness = stalenessNote(p.fixAgeSec);
  if (staleness) parts.push(staleness);

  if (parts.length === 0) return null;
  return `- ${row.callsign}: ${parts.join(', ')}`;
}

async function fetchAndFormat() {
  const monitorUrl = process.env.MONITOR_URL;
  const headers = {};
  if (process.env.MONITOR_API_KEY) headers.Authorization = `Bearer ${process.env.MONITOR_API_KEY}`;

  let rows;
  try {
    const response = await fetch(`${monitorUrl.replace(/\/+$/, '')}/api/positions`, { headers });
    if (!response.ok) throw new Error(`status ${response.status}`);
    rows = await response.json();
  } catch (err) {
    logger.warn(`Failed to fetch live positions: ${err.message}`);
    return null;
  }

  if (!Array.isArray(rows) || rows.length === 0) return null;
  const lines = rows.map(formatRow).filter(Boolean);
  if (lines.length === 0) return null;

  return [
    `Live reported aircraft positions (from a companion app some pilots may ` +
      `be running, which dead-reckons position from heading/speed between ` +
      `occasional manual map corrections) - treat these as an approximate ` +
      `estimate, not a confirmed fix. Always defer to what the pilot ` +
      `actually reports over the radio if it conflicts with this.`,
    ...lines,
  ].join('\n');
}

/**
 * Returns a formatted context block of currently-known live aircraft
 * positions, or null if MONITOR_URL isn't configured, the fetch fails, or
 * nothing is currently reported. Mirrors getFlightPlanContext()'s shape -
 * available to every position, not filtered like flight strips are, since
 * "where is this aircraft" is useful information regardless of who's asking.
 */
async function getPositionsContext() {
  if (!process.env.MONITOR_URL) return null;

  const now = Date.now();
  if (cache.text !== null && now < cache.expiresAt) return cache.text;
  if (inFlight) return inFlight;

  inFlight = fetchAndFormat()
    .then((text) => {
      cache = { text, expiresAt: Date.now() + CACHE_TTL_MS };
      return text;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

module.exports = { getPositionsContext };
