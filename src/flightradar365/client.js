const BASE_URL = 'https://flightradar365.lovable.app/api/public/bot';

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
};
