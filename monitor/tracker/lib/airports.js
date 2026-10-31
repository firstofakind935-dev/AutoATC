// Loads {icao, name, coordinates} for every airport this fleet knows about,
// straight from the same chart data the bots themselves use - so the
// calibration UI's "pick an airport" dropdown and the final distance/bearing
// output always agree with what a controller bot would call that airport.

const fs = require('fs');
const path = require('path');
const { distanceBearingNm } = require('./coords');

const CHARTS_DIR = path.join(__dirname, '..', 'data', 'charts');

// Grid nm -> the {lat, lon} the rest of the companion works in. 60 nm per degree both ways (north is -y),
// so lat/lon here are just the grid scaled down: the whole map is under half a degree tall.
const worldFromGrid = (xNm, yNm) => ({ lat: -yNm / 60, lon: xNm / 60 });

function loadAnchors() {
  try {
    return JSON.parse(fs.readFileSync(path.join(CHARTS_DIR, '..', 'worldAnchors.json'), 'utf8')).airports || {};
  } catch {
    return {};
  }
}

function loadAirports() {
  const files = fs.readdirSync(CHARTS_DIR).filter((f) => f.endsWith('.json'));
  const airports = [];
  const names = new Map();
  const anchors = loadAnchors();

  for (const file of files) {
    let chart;
    try {
      chart = JSON.parse(fs.readFileSync(path.join(CHARTS_DIR, file), 'utf8'));
    } catch {
      continue;
    }
    names.set(chart.icao, chart.name || chart.icao);
  }
  // Positions come from the radar's own airport placement (data/worldAnchors.json), as a point on a
  // flat nm grid - so what the companion measures and what the radar draws are the same thing. The
  // charts' lat/lon were not consistent with it (up to ~5 nm off for some airports), and the
  // calibration treats one degree east like one degree north.
  for (const [icao, a] of Object.entries(anchors)) {
    airports.push({ icao, name: names.get(icao) || icao, world: worldFromGrid(a.xNm, a.yNm) });
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
