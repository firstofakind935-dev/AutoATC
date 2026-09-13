const { makeLogger } = require('../utils/logger');

const logger = makeLogger('flight-strips');

const MONITOR_URL = process.env.MONITOR_URL || null;
const MONITOR_API_KEY = process.env.MONITOR_API_KEY || null;

// In-memory only - every bot in the fleet runs in this same Node process
// (see src/index.js), so a shared Map is enough to pass a strip between
// positions without a database. Resets on restart, same as each bot's own
// ConversationHistory.
const strips = new Map();

/**
 * Fire-and-forget push of one strip's current state to the monitor's
 * dashboard (see monitor/server.js's /api/flightstrip), for the Flight
 * Strips table on the "Radar" tab - a controller watching the board sees
 * what's being worked without joining the game. Same silent-on-failure
 * contract as datalink.js's sendDatalinkMessage: a monitor outage should
 * never affect a bot's own reply.
 */
function pushStripToMonitor(strip) {
  if (!MONITOR_URL) return;
  const headers = { 'Content-Type': 'application/json' };
  if (MONITOR_API_KEY) headers.Authorization = `Bearer ${MONITOR_API_KEY}`;

  fetch(`${MONITOR_URL.replace(/\/+$/, '')}/api/flightstrip`, {
    method: 'POST',
    headers,
    body: JSON.stringify(strip),
  })
    .then(async (response) => {
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        logger.warn(`Flight strip push for ${strip.callsign} rejected by monitor (${response.status}): ${body}`);
      }
    })
    .catch((err) => logger.warn(`Failed to push flight strip for ${strip.callsign}: ${err.message}`));
}

function normalizeCallsign(raw) {
  return (raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function getStrip(callsign) {
  return strips.get(normalizeCallsign(callsign)) || null;
}

/**
 * Creates or merges a flight strip for a callsign. `updates.currentPosition`
 * moves the strip to whichever position it was just handed off to;
 * `updates.clearance` fields are merged in (never dropped) so a detail set
 * by one position (e.g. Delivery's initial climb altitude) is still there
 * when Departure reads the strip later.
 */
function upsertStrip(callsign, updates = {}) {
  const key = normalizeCallsign(callsign);
  if (!key) return null;

  const existing = strips.get(key) || { callsign, clearance: {} };
  const merged = {
    ...existing,
    callsign: callsign || existing.callsign,
    currentPosition: updates.currentPosition || existing.currentPosition,
    clearance: { ...existing.clearance, ...(updates.clearance || {}) },
    updatedAt: new Date().toISOString(),
  };
  strips.set(key, merged);
  pushStripToMonitor(merged);
  return merged;
}

function stripsForPosition(position) {
  const lower = (position || '').toLowerCase();
  return [...strips.values()].filter((s) => (s.currentPosition || '').toLowerCase() === lower);
}

/**
 * Formats the strips currently handed off to `position` for injection into
 * that bot's context, mirroring getFlightPlanContext()'s shape - a real
 * controller doesn't re-ask a pilot for clearance details another position
 * already established.
 */
function formatStripsContext(position) {
  const relevant = stripsForPosition(position);
  if (relevant.length === 0) return null;

  const lines = relevant.map((s) => {
    const c = s.clearance || {};
    const parts = [];
    if (c.destination) parts.push(`destination ${c.destination}`);
    if (c.initialClimbAltitude) parts.push(`initial climb ${c.initialClimbAltitude}`);
    if (c.squawk) parts.push(`squawk ${c.squawk}`);
    if (c.departureFreq) parts.push(`departure freq ${c.departureFreq}`);
    return `- ${s.callsign}${parts.length ? `: ${parts.join(', ')}` : ' (no clearance details recorded)'}`;
  });

  return [
    `Flight strips handed off to you from an earlier position - match a ` +
      `pilot's spoken callsign against these generously (same as flight ` +
      `plans) and use the recorded details instead of asking again:`,
    ...lines,
  ].join('\n');
}

/**
 * Parses a trailing "STRIP: {...}" line off a raw model reply (see
 * systemPrompt.js's output contract) and applies it to the store. Returns
 * the reply text with that line removed - the STRIP line is metadata for
 * the next controller, never spoken aloud. Malformed JSON is logged and
 * dropped rather than breaking the reply.
 */
function applyStripDirective(replyText) {
  // Matches on the literal "STRIP:" marker alone, not on well-formed JSON
  // following it - a malformed directive should still never end up spoken
  // aloud, it should just fail to apply.
  const match = replyText.match(/\n?STRIP:\s*([\s\S]*)$/i);
  if (!match) return replyText;

  const spoken = replyText.slice(0, match.index).trim();
  try {
    const directive = JSON.parse(match[1].trim());
    if (directive.callsign) {
      upsertStrip(directive.callsign, {
        currentPosition: directive.handoffTo,
        clearance: directive.clearance,
      });
    }
  } catch (err) {
    logger.warn(`Failed to parse STRIP directive: ${err.message} - raw: ${match[1]}`);
  }
  return spoken;
}

module.exports = { getStrip, upsertStrip, stripsForPosition, formatStripsContext, applyStripDirective };
