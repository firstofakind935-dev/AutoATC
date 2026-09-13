// Loads {icao, name, coordinates} for every airport this fleet knows about,
// straight from the same chart data the bots themselves use - so the
// calibration UI's "pick an airport" dropdown and the final distance/bearing
// output always agree with what a controller bot would call that airport.

const fs = require('fs');
const path = require('path');
const { parseCoordinates, distanceBearingNm } = require('./coords');

const CHARTS_DIR = path.join(__dirname, '..', 'data', 'charts');

function loadAirports() {
  const files = fs.readdirSync(CHARTS_DIR).filter((f) => f.endsWith('.json'));
  const airports = [];

  for (const file of files) {
    let chart;
    try {
      chart = JSON.parse(fs.readFileSync(path.join(CHARTS_DIR, file), 'utf8'));
    } catch {
      continue;
    }
    const world = parseCoordinates(chart.coordinates);
    if (!world) continue;
    airports.push({ icao: chart.icao, name: chart.name || chart.icao, world });
  }

  airports.sort((a, b) => a.icao.localeCompare(b.icao));
  return airports;
}

/**
 * Finds the closest airport to `world` from `airports` (as returned by
 * loadAirports()), so a corrected/estimated position can always be reported
 * relative to whichever known field is actually nearby right now - not
 * whatever airport happened to be used for the last calibration.
 */
function nearestAirport(airports, world) {
  let best = null;
  let bestDistance = Infinity;
  for (const airport of airports) {
    const { distanceNm, bearingDeg } = distanceBearingNm(airport.world, world);
    if (distanceNm < bestDistance) {
      bestDistance = distanceNm;
      best = { icao: airport.icao, distanceNm, bearingDeg };
    }
  }
  return best;
}

module.exports = { loadAirports, nearestAirport };
