const { reportPositions } = require('./client');
const { makeLogger } = require('../utils/logger');
const groundOffsets = require('./groundOffsets');

const logger = makeLogger('flightradar365-track');

const SYNC_INTERVAL_MS = 10_000;
// Studs per nautical mile - derived from 24radar.xyz's own measuring tool
// (see monitor/public/radar24/src/main.js's matching constant/comment).
// Only meaningful if flightradar365.lovable.app's map turns out to use
// that same raw-stud coordinate space - see toTrackXY() below.
const STUDS_PER_NM = 3307.14286;

/**
 * Converts one of AutoATC's own positions (polar - distanceNm/bearingDeg
 * from a named referenceAirport, see src/atc/positions.js) into
 * flightradar365's required {x, y}.
 *
 * UNVERIFIED: this assumes the site's map uses the same raw PTFS/Roblox
 * world-stud coordinate space (and the same per-airport anchor points)
 * that 24radar.xyz/monitor/public/radar24 does - plausible, since both are
 * ATC24/PTFS-specific tools, but not confirmed against the live site.
 * Before relying on this, cross-check: send one aircraft with a known
 * distance/bearing from a well-known airport, and confirm the resulting
 * x/y lands in the right place on the actual flightradar365 map. If it
 * doesn't, this function - not the sync loop around it - is what needs to
 * change.
 */
function toTrackXY({ distanceNm, bearingDeg, referenceAirport }) {
  const anchor = groundOffsets[referenceAirport];
  if (!anchor || typeof distanceNm !== 'number' || typeof bearingDeg !== 'number') return null;

  const rad = (bearingDeg * Math.PI) / 180;
  const offsetSvgUnits = (distanceNm * STUDS_PER_NM) / 100;
  return {
    x: (anchor.x + offsetSvgUnits * Math.sin(rad)) * 100,
    y: (anchor.y - offsetSvgUnits * Math.cos(rad)) * 100,
  };
}

async function fetchOwnPositions() {
  const monitorUrl = process.env.MONITOR_URL;
  if (!monitorUrl) return [];

  const headers = {};
  if (process.env.MONITOR_API_KEY) headers.Authorization = `Bearer ${process.env.MONITOR_API_KEY}`;

  const response = await fetch(`${monitorUrl.replace(/\/+$/, '')}/api/positions`, { headers });
  if (!response.ok) throw new Error(`monitor responded ${response.status}`);
  const rows = await response.json();
  return Array.isArray(rows) ? rows : [];
}

async function syncOnce() {
  let rows;
  try {
    rows = await fetchOwnPositions();
  } catch (err) {
    logger.warn(`Failed to fetch positions from the monitor: ${err.message}`);
    return;
  }
  if (rows.length === 0) return;

  const aircraft = rows
    .map((row) => {
      const xy = toTrackXY(row.position || {});
      if (!xy || !row.callsign) return null;

      const entry = { callsign: row.callsign, x: xy.x, y: xy.y };
      if (typeof row.position.altitudeFt === 'number') entry.altitude = row.position.altitudeFt;
      if (typeof row.speed === 'number') entry.ground_speed = row.speed;
      if (typeof row.position.headingDeg === 'number') entry.heading = row.position.headingDeg;
      return entry;
    })
    .filter(Boolean);

  if (aircraft.length === 0) return;

  try {
    // replace: true - so an aircraft that stops being tracked by AutoATC
    // disappears from flightradar365's map on the next cycle, instead of
    // waiting out the site's own 3-minute auto-expiry.
    await reportPositions(aircraft, { replace: true });
  } catch (err) {
    logger.warn(`Failed to push positions to flightradar365: ${err.message}`);
  }
}

let timer = null;

/**
 * Starts periodically pushing AutoATC's live positions to
 * flightradar365.lovable.app's own map. Off unless BOTH
 * FLIGHTRADAR365_BOT_KEY and FLIGHTRADAR365_TRACK_ENABLED=true are set -
 * deliberately not on just because a bot key is configured, since
 * toTrackXY() above is an unverified guess at the site's coordinate
 * system. Confirm that against the live site first (see its comment),
 * then opt in.
 */
function startPositionSync() {
  if (!process.env.FLIGHTRADAR365_BOT_KEY) return;
  if (process.env.FLIGHTRADAR365_TRACK_ENABLED !== 'true') {
    logger.info(
      'FLIGHTRADAR365_BOT_KEY is set but FLIGHTRADAR365_TRACK_ENABLED is not "true" - not pushing ' +
        'positions to flightradar365 yet (the x/y coordinate conversion needs confirming against the ' +
        'live site first - see src/flightradar365/positionSync.js).'
    );
    return;
  }
  logger.info(`Pushing live positions to flightradar365.lovable.app every ${SYNC_INTERVAL_MS / 1000}s.`);
  syncOnce();
  timer = setInterval(syncOnce, SYNC_INTERVAL_MS);
}

function stopPositionSync() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { startPositionSync, stopPositionSync, toTrackXY };
