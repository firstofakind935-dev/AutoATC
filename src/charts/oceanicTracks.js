const fs = require('fs');
const path = require('path');
const { makeLogger } = require('../utils/logger');

const logger = makeLogger('oceanic-tracks');
const DATA_PATH = path.join(__dirname, '..', '..', 'data', 'oceanic-tracks.json');

let cachedContext; // computed once - this is static reference data, not live

/**
 * Returns a formatted text block of the named oceanic tracks connecting
 * islands (from the ATC365 Oceanic Tracks Chart), for injection into the
 * LLM's context so it can reference real track letters and entry/exit
 * points instead of inventing an oceanic clearance. Returns null if
 * data/oceanic-tracks.json is missing.
 */
function getOceanicTracksContext() {
  if (cachedContext !== undefined) return cachedContext;

  try {
    const tracks = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    if (!Array.isArray(tracks) || tracks.length === 0) {
      cachedContext = null;
    } else {
      const lines = tracks.map((t) => `- Track ${t.track}: ${t.point1} <-> ${t.point2}`);
      cachedContext = [
        'Known oceanic tracks (named routes between island entry/exit points; use these ' +
          "if a pilot requests an oceanic clearance or references a track by letter):",
        ...lines,
      ].join('\n');
    }
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn(`Failed to load oceanic track data: ${err.message}`);
    cachedContext = null;
  }

  return cachedContext;
}

module.exports = { getOceanicTracksContext };
