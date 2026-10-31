const { getFlightPlans } = require('../flightradar365/client');
const { makeLogger } = require('../utils/logger');

const logger = makeLogger('flightplans');

const CACHE_TTL_MS = 30_000;
const MAX_ROWS = 50;

let cache = { text: null, expiresAt: 0 };
let inFlight = null;

/**
 * Returns a formatted text block listing currently filed flight plans, for
 * injection into the LLM's context so it can match a spoken callsign to a
 * known plan. Returns null if flight plan lookup isn't configured, the
 * request fails, or there are no rows - callers should just skip the
 * context block in that case rather than fail the whole reply.
 */
async function getFlightPlanContext() {
  if (!process.env.FLIGHTRADAR365_BOT_KEY && !process.env.MONITOR_URL) return null;

  const now = Date.now();
  if (cache.text !== null && now < cache.expiresAt) {
    return cache.text;
  }
  if (inFlight) return inFlight;

  inFlight = fetchAndFormat()
    .then((text) => {
      cache = { text, expiresAt: Date.now() + CACHE_TTL_MS };
      return text;
    })
    .catch((err) => {
      logger.warn(`Failed to fetch flight plans: ${err.message}`);
      return null;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/**
 * The exact response envelope from GET .../data?resource=flight_plans
 * isn't confirmed against real API docs - this handles a few reasonable
 * shapes (bare array, {data: [...]}, {flight_plans: [...]}) and logs the
 * actual top-level keys if none match, so a wrong assumption here is
 * diagnosable from the logs instead of just silently returning nothing.
 */
function extractRows(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.data)) return response.data;
  if (Array.isArray(response?.flight_plans)) return response.flight_plans;
  logger.warn(`Unrecognized flight_plans response shape - top-level keys: ${Object.keys(response || {}).join(', ') || '(none)'}`);
  return [];
}

// The event's own flight plans, filed at <monitor>/fpl (monitor/flightPlans.js): callsign, type, dep, arr; route
// always radar vectors, with an assigned squawk.
async function getEventFlightPlans() {
  const base = (process.env.MONITOR_URL || '').replace(/\/+$/, '');
  if (!base) return [];
  const r = await fetch(`${base}/api/flightplans`, { headers: process.env.MONITOR_API_KEY ? { Authorization: `Bearer ${process.env.MONITOR_API_KEY}` } : {} });
  if (!r.ok) throw new Error(`event flight plans: ${r.status}`);
  const d = await r.json();
  return (d.plans || []).map((p) => ({
    callsign: p.callsign, aircraft: p.aircraft, dep_icao: p.dep, arr_icao: p.arr, flight_rules: p.rules || 'IFR',
    route: p.rules === 'VFR' ? 'VFR' : 'radar vectors', squawk: p.squawk, cruise_alt: p.cruise || null,
    remarks: [p.gate && `at gate ${p.gate}`, p.filedRoute && `asked for route "${p.filedRoute}" (clear via radar vectors)`].filter(Boolean).join('; ') || null,
  }));
}

async function fetchAndFormat() {
  // both sources, each optional: one failing (flightradar365 currently answers 401) doesn't hide the other
  const [event, fr365] = await Promise.all([
    getEventFlightPlans().catch((err) => { logger.warn(`Failed to fetch event flight plans: ${err.message}`); return []; }),
    process.env.FLIGHTRADAR365_BOT_KEY
      ? getFlightPlans().then(extractRows).catch((err) => { logger.warn(`Failed to fetch flight plans: ${err.message}`); return []; })
      : [],
  ]);
  const seen = new Set();
  const rows = [...event, ...fr365].filter((r) => r && r.callsign && !seen.has(String(r.callsign).toUpperCase()) && seen.add(String(r.callsign).toUpperCase())).slice(0, MAX_ROWS);
  if (rows.length === 0) return null;

  const lines = rows.filter((row) => row.callsign).map(formatRow);
  if (lines.length === 0) return null;

  return [
    'Known filed flight plans (match the pilot\'s spoken callsign against these; if none match, proceed with just the transmission). ' +
      'A plan with route "radar vectors" is cleared to its destination via radar vectors: e.g. "DAL123, cleared to Tokyo via radar vectors, ' +
      'climb and maintain 4000, departure runway as assigned, squawk 4521" - use the plan\'s own squawk:',
    ...lines,
  ].join('\n');
}

function formatRow(row) {
  const parts = [`- ${row.callsign}`];

  const aircraft = [row.aircraft, row.aircraft_icao].filter(Boolean).join(' ');
  if (aircraft) parts.push(aircraft);
  if (row.registration) parts.push(`reg ${row.registration}`);
  if (row.flight_rules) parts.push(row.flight_rules);

  if (row.dep_icao || row.arr_icao) {
    parts.push(`${row.dep_icao || '?'} to ${row.arr_icao || '?'}`);
  }
  if (row.cruise_alt) parts.push(`cruise ${row.cruise_alt} ft`);
  if (row.cruise_speed) parts.push(`${row.cruise_speed} kt`);
  if (row.squawk) parts.push(`squawk ${row.squawk}`);
  if (row.route) parts.push(`route: ${row.route}`);
  if (Array.isArray(row.waypoints) && row.waypoints.length > 0) {
    parts.push(`waypoints: ${row.waypoints.join(' ')}`);
  }
  if (row.remarks) parts.push(`remarks: ${row.remarks}`);
  if (row.atc_note) parts.push(`ATC note: ${row.atc_note}`);

  return parts.join(', ');
}

module.exports = { getFlightPlanContext };
