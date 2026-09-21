// Position seniority, lowest to highest - used when a bot goes offline to
// decide who inherits its traffic. Apron/Delivery/Ground/Tower are scoped to
// one airport (persona.airport); Approach/Departure/Center aren't reliably
// scoped to a single airport at all (see src/charts/frequencies.js's comment
// on Center stations covering multiple airports) - they're treated as
// regional fallbacks rather than searched for per-airport.
const RANK = {
  Delivery: 0,
  Apron: 1,
  Ground: 2,
  Tower: 3,
  Approach: 4,
  Departure: 4,
  Center: 5,
};

const AIRPORT_SCOPED_POSITIONS = ['Delivery', 'Apron', 'Ground', 'Tower'];
const REGIONAL_POSITIONS = ['Approach', 'Departure', 'Center'];

/**
 * Given the offline bot's config and the fleet's other configs, returns the
 * config of whichever bot should now cover its traffic, or null if nothing
 * in the fleet is a suitable fallback (the caller should treat that as
 * "Center itself needs to step in" - see BotManagerBot's centerFallback).
 *
 * `isOnline(botName)` is injected rather than read from a shared status map
 * directly, so this stays pure and easy to test against a fixed status
 * snapshot instead of live /api/status state.
 */
function findFallback(offlineBot, allConfigs, isOnline) {
  const { position, airport } = offlineBot.persona || {};
  if (!position || !(position in RANK)) return null;

  if (AIRPORT_SCOPED_POSITIONS.includes(position) && airport) {
    // Walk up in rank at the same airport first (e.g. Ground -> Tower, not
    // straight to Center) - a lower rank never inherits a higher one's
    // traffic, since it's less authorized, not more.
    const candidates = allConfigs
      .filter((c) => c.name !== offlineBot.name && c.persona && c.persona.airport === airport && c.persona.position in RANK)
      .filter((c) => RANK[c.persona.position] > RANK[position])
      .filter((c) => isOnline(c.name))
      .sort((a, b) => RANK[a.persona.position] - RANK[b.persona.position]);
    if (candidates.length > 0) return candidates[0];
  }

  // Nothing higher at the same airport (or this position isn't
  // airport-scoped to begin with) - fall back to whichever regional
  // position (Approach/Departure/Center) is online, preferring the lowest
  // rank among those, i.e. Approach/Departure over Center, since Center
  // taking over is meant to be the last resort.
  const regional = allConfigs
    .filter((c) => c.name !== offlineBot.name && c.persona && REGIONAL_POSITIONS.includes(c.persona.position))
    .filter((c) => isOnline(c.name))
    .sort((a, b) => RANK[a.persona.position] - RANK[b.persona.position]);

  return regional[0] || null;
}

module.exports = { RANK, AIRPORT_SCOPED_POSITIONS, REGIONAL_POSITIONS, findFallback };
