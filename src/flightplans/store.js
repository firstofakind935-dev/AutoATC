const { getSupabaseClient } = require('./supabaseClient');
const { makeLogger } = require('../utils/logger');

const logger = makeLogger('flightplans');

const TABLE = process.env.SUPABASE_FLIGHT_PLANS_TABLE || 'flight_plans';
const CACHE_TTL_MS = 30_000;
const MAX_ROWS = 50;

// Expected columns on the configured table - only "callsign" is required,
// everything else is optional and skipped if missing/null on a row. If
// your Lovable/Supabase schema uses different column names, this is the
// one place to adjust the mapping.
const COLUMNS = 'callsign, departure, arrival, route, aircraft_type, cruise_altitude, remarks';

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
  const { data, error } = await supabase.from(TABLE).select(COLUMNS).limit(MAX_ROWS);
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) return null;

  const lines = data
    .filter((row) => row.callsign)
    .map((row) => formatRow(row));

  if (lines.length === 0) return null;

  return [
    'Known filed flight plans (match the pilot\'s spoken callsign against these; if none match, proceed with just the transmission):',
    ...lines,
  ].join('\n');
}

function formatRow(row) {
  const parts = [`- ${row.callsign}`];
  if (row.aircraft_type) parts.push(row.aircraft_type);
  if (row.departure || row.arrival) {
    parts.push(`${row.departure || '?'} to ${row.arrival || '?'}`);
  }
  if (row.cruise_altitude) parts.push(`cruise ${row.cruise_altitude}`);
  if (row.route) parts.push(`route: ${row.route}`);
  if (row.remarks) parts.push(`remarks: ${row.remarks}`);
  return parts.join(', ');
}

module.exports = { getFlightPlanContext };
