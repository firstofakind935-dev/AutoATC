const { getSupabaseClient } = require('./supabaseClient');
const { makeLogger } = require('../utils/logger');

const logger = makeLogger('flightplans');

const TABLE = process.env.SUPABASE_FLIGHT_PLANS_TABLE || 'flight_plans';
const CACHE_TTL_MS = 30_000;
const MAX_ROWS = 50;

// Matches the AutoATC app's actual flight_plans schema. "status" and
// "atc_status" both exist but aren't filtered on below since their valid
// values aren't pinned down yet - the DB also has a
// delete_landed_flight_plans() RPC function, which suggests landed
// flights are already removed server-side. Add a .eq()/.in() filter in
// fetchAndFormat() if stale (e.g. not-yet-approved) plans start showing
// up here.
const COLUMNS =
  'callsign, aircraft, aircraft_icao, registration, dep_icao, arr_icao, route, waypoints, ' +
  'cruise_alt, cruise_speed, squawk, flight_rules, remarks, atc_note, status, atc_status, updated_at';

let cache = { text: null, expiresAt: 0 };
let inFlight = null;

/**
 * Returns a formatted text block listing currently filed flight plans, for
 * injection into the LLM's context so it can match a spoken callsign to a
 * known plan. Returns null if flight plan lookup isn't configured, the
 * query fails, or there are no rows - callers should just skip the
 * context block in that case rather than fail the whole reply.
 */
async function getFlightPlanContext() {
  const supabase = getSupabaseClient();
  if (!supabase) return null;

  const now = Date.now();
  if (cache.text !== null && now < cache.expiresAt) {
    return cache.text;
  }
  if (inFlight) return inFlight;

  inFlight = fetchAndFormat(supabase)
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

async function fetchAndFormat(supabase) {
  const { data, error } = await supabase
    .from(TABLE)
    .select(COLUMNS)
    .order('updated_at', { ascending: false })
    .limit(MAX_ROWS);
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) return null;

  const lines = data.filter((row) => row.callsign).map(formatRow);
  if (lines.length === 0) return null;

  return [
    'Known filed flight plans (match the pilot\'s spoken callsign against these; if none match, proceed with just the transmission):',
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
