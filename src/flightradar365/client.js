const BASE_URL = 'https://flightradar365.lovable.app/api/public/bot';
const TRACK_URL = 'https://flightradar365.lovable.app/api/public/track';

function authHeaders() {
  const key = process.env.FLIGHTRADAR365_BOT_KEY;
  if (!key) throw new Error('FLIGHTRADAR365_BOT_KEY is not set');
  return { 'x-bot-key': key };
}

/**
 * Reads one resource ("airports", "flight_plans", or "atis") from the
 * flightradar365 bot API.
 */
async function getResource(resource) {
  const response = await fetch(`${BASE_URL}/data?resource=${encodeURIComponent(resource)}`, {
    headers: authHeaders(),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`flightradar365 GET "${resource}" failed (${response.status}): ${body}`);
  }
  return response.json();
}

/**
 * Sends a write action ("publish_atis", "update_flight_plan", or
 * "delete_flight_plan") to the flightradar365 bot API. `payload` is
 * merged alongside "action" in the request body - the exact fields each
 * action expects aren't confirmed against real API docs yet, so callers
 * should treat this as provisional until verified against a real request.
 */
async function writeAction(action, payload = {}) {
  const response = await fetch(`${BASE_URL}/write`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`flightradar365 write "${action}" failed (${response.status}): ${body}`);
  }
  return response.json().catch(() => null);
}

/**
 * Reports live aircraft positions to the site's own map (a different
 * endpoint from the read/write "bot" API above - /api/public/track, not
 * /api/public/bot/...). `aircraft` is an array of
 * {callsign, x, y, altitude?, ground_speed?, heading?} in the site's own
 * map coordinate space - see src/flightradar365/positionSync.js for how
 * AutoATC's own distanceNm/bearingDeg/referenceAirport positions get
 * converted into that space. `replace: true` tells the site to drop any
 * aircraft not in this call (used every sync cycle so an aircraft that
 * stops being tracked disappears immediately, instead of waiting out the
 * site's own 3-minute auto-expiry).
 */
async function reportPositions(aircraft, { replace = false } = {}) {
  const response = await fetch(TRACK_URL, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ aircraft, ...(replace ? { replace: true } : {}) }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`flightradar365 track POST failed (${response.status}): ${body}`);
  }
  return response.json().catch(() => null);
}

async function getAirports() {
  return getResource('airports');
}

async function getFlightPlans() {
  return getResource('flight_plans');
}

async function getAtis() {
  return getResource('atis');
}

async function publishAtis(payload) {
  return writeAction('publish_atis', payload);
}

async function updateFlightPlan(payload) {
  return writeAction('update_flight_plan', payload);
}

async function deleteFlightPlan(payload) {
  return writeAction('delete_flight_plan', payload);
}

module.exports = {
  getAirports,
  getFlightPlans,
  getAtis,
  publishAtis,
  updateFlightPlan,
  deleteFlightPlan,
  reportPositions,
};
