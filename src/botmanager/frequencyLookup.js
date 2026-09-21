// Resolves a frequency string (what a pilot dials in the companion app) to
// the fleet bot config that owns it, so BotManagerBot knows which voice
// channel to move a pilot into.
//
// data/frequencies.json (src/charts/frequencies.js's source) has
// {station, frequency, callsign} rows, e.g. {station: "IRFD GND",
// frequency: "118.100", callsign: "Rockford Ground"}. There's no direct
// foreign key from a station row to a fleet bot config entry, so this
// matches heuristically, same spirit as scripts/extract-charts.js's own
// "heuristic, not a real parser - spot-check it" chart extraction:
//
//   1. Airport-scoped positions (Delivery/Apron/Ground/Tower/Approach/
//      Departure): station is "<ICAO> <ABBR>" - build the same string from
//      the bot's persona.airport + persona.position and compare.
//   2. Center: station codes don't follow that pattern (e.g. "IRCC", not
//      "IRFD CTR") - match by callsign text instead, since a Center bot's
//      persona.callsign is expected to equal the frequency row's callsign
//      (e.g. both "Rockford Center").
//
// Any fleet bot this can't resolve is logged, not silently dropped - an
// operator should notice and either fix the mismatch or accept that
// position isn't tunable yet.

const fs = require('fs');
const path = require('path');
const { makeLogger } = require('../utils/logger');

const logger = makeLogger('freq-lookup');
const DATA_PATH = path.join(__dirname, '..', '..', 'data', 'frequencies.json');

const POSITION_ABBR = {
  Delivery: 'DEL',
  Apron: 'APRON',
  Ground: 'GND',
  Tower: 'TWR',
  Approach: 'APP',
  Departure: 'DEP',
};

function normalizeFrequency(raw) {
  return (raw || '').trim();
}

function loadStations() {
  try {
    const rows = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn(`Failed to load frequency data: ${err.message}`);
    return [];
  }
}

/**
 * Returns a Map of normalized frequency string -> fleet bot config, built
 * once from the current fleet config. `botConfigs` is every config entry
 * with a voice position (i.e. AtcBot-type entries - ATIS/Bot Manager itself
 * don't have a tunable frequency).
 */
function buildFrequencyMap(botConfigs) {
  const stations = loadStations();
  const map = new Map();
  const unresolved = [];

  for (const bot of botConfigs) {
    const { position, airport, callsign } = bot.persona || {};
    if (!position) continue;

    let station;
    if (position === 'Center') {
      station = stations.find((s) => (s.callsign || '').toLowerCase() === (callsign || '').toLowerCase());
    } else if (airport && POSITION_ABBR[position]) {
      const expected = `${airport} ${POSITION_ABBR[position]}`.toLowerCase();
      station = stations.find((s) => (s.station || '').toLowerCase() === expected);
    }

    if (!station) {
      unresolved.push(bot.name);
      continue;
    }
    map.set(normalizeFrequency(station.frequency), bot);
  }

  if (unresolved.length > 0) {
    logger.warn(
      `Could not resolve a frequency for: ${unresolved.join(', ')} - these positions won't be reachable by ` +
        `dialing a frequency in the companion app until data/frequencies.json and config/bots.json agree ` +
        `on that station's naming.`
    );
  }

  return map;
}

module.exports = { buildFrequencyMap, normalizeFrequency };
