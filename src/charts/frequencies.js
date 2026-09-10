const fs = require('fs');
const path = require('path');
const { makeLogger } = require('../utils/logger');

const logger = makeLogger('frequencies');
const DATA_PATH = path.join(__dirname, '..', '..', 'data', 'frequencies.json');

let cachedContext; // computed once - this is static reference data, not live

/**
 * Returns a formatted text block of real station frequencies and
 * callsigns across the whole PTFS network (from a hand-compiled Google
 * Sheet, not the chart SVG extraction - the two disagreed on IZOL's
 * Ground/Delivery frequencies, so this sheet is treated as the
 * authoritative source and chart-extracted frequency lines were dropped
 * from src/charts/store.js to avoid handing the LLM two conflicting
 * numbers for the same thing).
 *
 * Deliberately not filtered per-airport before injection, same as
 * getOceanicTracksContext() - Center stations cover multiple airports in
 * ways not reliably derivable from station codes alone (e.g. Tokyo
 * Center "IOCC" covers Tokyo "ITKO" plus at least two other airports,
 * with no shared prefix), so guessing a per-airport subset risked
 * silently excluding or mismatching a bot's own frequency. The full list
 * is static reference data (Ollama's prompt caching means this doesn't
 * cost anything after the first request per bot process, same as the
 * chart/oceanic context), and the LLM picks out what's relevant.
 */
function getFrequencyContext() {
  if (cachedContext !== undefined) return cachedContext;

  try {
    const stations = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    if (!Array.isArray(stations) || stations.length === 0) {
      cachedContext = null;
    } else {
      const lines = stations.map((s) => `- ${s.station}: ${s.frequency} (${s.callsign})`);
      cachedContext = [
        'Real station frequencies and callsigns across the network (use these ' +
          "instead of inventing a frequency or callsign for any station):",
        ...lines,
      ].join('\n');
    }
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn(`Failed to load frequency data: ${err.message}`);
    cachedContext = null;
  }

  return cachedContext;
}

module.exports = { getFrequencyContext };
