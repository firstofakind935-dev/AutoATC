#!/usr/bin/env node
/**
 * Builds a colored world-map background for the radar's fleet-wide
 * overview, from the community ptfs-charts repo's own "Enroute Chart
 * PTFS.svg" - a real colored chart of the whole game world (water,
 * islands, ARTCC boundaries, navaids), not a fabricated topographic map
 * (this fictional game world has no real elevation data to draw from).
 *
 * That chart has no machine-readable airport labels - Inkscape "object to
 * path" was applied to all its text, so every letter is an anonymous
 * glyph outline, not a <text> element. Positions for the calibration
 * points below were read once with OCR (tesseract) against a 3200px-wide
 * render and are hardcoded here; redo that (see bottom of this file) only
 * if the chart image itself changes.
 *
 * The chart is explicitly labeled "NOT TO SCALE", so this can only ever
 * be an approximate visual backdrop - a best-fit affine transform (not a
 * rigid rotation+scale) from a handful of real airport positions, fit by
 * least squares. Expect some drift between the drawn coastline and where
 * an airport's own precisely-computed dot actually lands, especially for
 * airports far from the calibration points.
 *
 * Usage: node scripts/build-worldmap.js <path-to-cloned-ptfs-charts-repo>
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CHARTS_DIR = path.join(__dirname, '..', 'data', 'charts');
const SOURCE_ROOT = process.argv[2];
const OUT_PNG = path.join(__dirname, '..', 'monitor', 'public', 'worldmap.png');
const OUT_JSON = path.join(__dirname, '..', 'monitor', 'public', 'worldmap.json');

if (!SOURCE_ROOT) {
  console.error('Usage: node scripts/build-worldmap.js <path-to-cloned-ptfs-charts-repo>');
  process.exit(1);
}

const NM_PER_DEG_LAT = 60;
function nmPerDegLon(atLat) {
  return NM_PER_DEG_LAT * Math.cos((atLat * Math.PI) / 180);
}

// Minimal port of companion/lib/coords.js's parseCoordinates - avoids a
// cross-package require from scripts/.
function parseCoordinates(str) {
  if (!str) return null;
  const m = /N(\d+)\s+(\d+(?:\.\d+)?)\s+[EW](\d+)\s+(\d+(?:\.\d+)?)/.exec(str);
  if (!m) return null;
  const [, latDeg, latMin, lonDeg, lonMin] = m;
  const lat = parseFloat(latDeg) + parseFloat(latMin) / 60;
  const lonSign = /W/.test(str) ? -1 : 1;
  const lon = lonSign * (parseFloat(lonDeg) + parseFloat(lonMin) / 60);
  return { lat, lon };
}

// Pixel centers at a 3200px-wide render of "Enroute Chart PTFS.svg",
// read via: tesseract enroute_hi.png out tsv (see file header).
const CALIBRATION_RENDER_WIDTH = 3200;
const CALIBRATION_POINTS_PX = {
  TVO: { px: 529, py: 1155 },
  IMLR: { px: 1177.5, py: 1547.5 },
  ITKO: { px: 1523.5, py: 428 },
  IBLT: { px: 1367, py: 1537.5 },
  IBTH: { px: 1716, py: 1020.5 },
  IPPH: { px: 2071.5, py: 683.5 },
  IRFD: { px: 1541.5, py: 1666.5 },
  ITRC: { px: 1614, py: 1912.5 },
  IHEN: { px: 1989, py: 2127.5 },
  ILKL: { px: 2254, py: 722.5 },
  ISCM: { px: 2591.5, py: 1036 },
  IZOL: { px: 2663.5, py: 1194.5 },
  IPAP: { px: 2353, py: 1910.5 },
  ILAR: { px: 2174.5, py: 1944.5 },
  IBAR: { px: 2235.5, py: 2020.5 },
};

// ---------- least-squares affine fit: (px,py) -> (north,east) ----------
// north = a*px + b*py + e ; east = c*px + d*py + f, each a 3-parameter
// linear regression solved via the normal equations (3x3 solve).

function solve3x3(A, y) {
  // Cramer's rule - small enough system that a general solver is overkill.
  const det = (m) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(A);
  const replace = (col) => A.map((row, i) => row.map((v, j) => (j === col ? y[i] : v)));
  return [det(replace(0)) / D, det(replace(1)) / D, det(replace(2)) / D];
}

function fitAffine(points) {
  // Normal equations for [a,b,e] minimizing sum((a*px+b*py+e - north)^2),
  // and likewise for [c,d,f] against east.
  let sxx = 0, sxy = 0, sx = 0, syy = 0, sy = 0, n = points.length;
  let sxN = 0, syN = 0, sN = 0, sxE = 0, syE = 0, sE = 0;
  for (const p of points) {
    sxx += p.px * p.px;
    sxy += p.px * p.py;
    sx += p.px;
    syy += p.py * p.py;
    sy += p.py;
    sxN += p.px * p.north;
    syN += p.py * p.north;
    sN += p.north;
    sxE += p.px * p.east;
    syE += p.py * p.east;
    sE += p.east;
  }
  const A = [
    [sxx, sxy, sx],
    [sxy, syy, sy],
    [sx, sy, n],
  ];
  const [a, b, e] = solve3x3(A, [sxN, syN, sN]);
  const [c, d, f] = solve3x3(A, [sxE, syE, sE]);
  return { a, b, c, d, e, f };
}

function main() {
  // Same origin convention as monitor/public/airports.json / radar.js's
  // toNm() - the centroid of every charted airport - so this transform
  // composes directly with the radar's existing NM-space projection.
  const files = fs.readdirSync(CHARTS_DIR).filter((f) => f.endsWith('.json'));
  const allAirports = [];
  for (const f of files) {
    const chart = JSON.parse(fs.readFileSync(path.join(CHARTS_DIR, f), 'utf8'));
    const world = parseCoordinates(chart.coordinates);
    if (chart.icao && world) allAirports.push({ icao: chart.icao, ...world });
  }
  const origin = {
    lat: allAirports.reduce((s, a) => s + a.lat, 0) / allAirports.length,
    lon: allAirports.reduce((s, a) => s + a.lon, 0) / allAirports.length,
  };
  function toNm(a) {
    return {
      north: (a.lat - origin.lat) * NM_PER_DEG_LAT,
      east: (a.lon - origin.lon) * nmPerDegLon(origin.lat),
    };
  }

  const points = [];
  for (const [icao, px] of Object.entries(CALIBRATION_POINTS_PX)) {
    const airport = allAirports.find((a) => a.icao === icao);
    if (!airport) {
      console.warn(`Calibration point ${icao} not found in data/charts - skipping`);
      continue;
    }
    const nm = toNm(airport);
    points.push({ px: px.px, py: px.py, north: nm.north, east: nm.east });
  }
  if (points.length < 6) {
    console.error(`Only ${points.length} calibration points resolved - need at least 6 for a stable affine fit.`);
    process.exit(1);
  }

  const transform = fitAffine(points);

  // Report fit quality: how far each calibration point's own predicted
  // (north,east) falls from its real one, in NM.
  let maxErr = 0;
  for (const p of points) {
    const predNorth = transform.a * p.px + transform.b * p.py + transform.e;
    const predEast = transform.c * p.px + transform.d * p.py + transform.f;
    const err = Math.hypot(predNorth - p.north, predEast - p.east);
    maxErr = Math.max(maxErr, err);
  }
  console.log(`Fit ${points.length} calibration points, max residual ${maxErr.toFixed(2)}nm`);

  const svgPath = path.join(SOURCE_ROOT, 'Airspace map', 'Enroute Chart PTFS.svg');
  if (!fs.existsSync(svgPath)) {
    console.error(`Source chart not found at ${svgPath}`);
    process.exit(1);
  }
  const RENDER_WIDTH = 2000; // background layer, not fine detail - keep the asset small
  execFileSync('rsvg-convert', ['-w', String(RENDER_WIDTH), svgPath, '-o', OUT_PNG]);
  const renderScale = RENDER_WIDTH / CALIBRATION_RENDER_WIDTH;

  fs.writeFileSync(
    OUT_JSON,
    JSON.stringify(
      {
        imageWidth: RENDER_WIDTH,
        // Scale the fitted pixel-space coefficients (a,b / c,d) down to
        // match the actually-rendered PNG's resolution; the constant
        // terms (e,f) are independent of image scale.
        transform: {
          a: transform.a / renderScale,
          b: transform.b / renderScale,
          c: transform.c / renderScale,
          d: transform.d / renderScale,
          e: transform.e,
          f: transform.f,
        },
      },
      null,
      2
    ) + '\n'
  );
  console.log(`Wrote ${OUT_PNG} and ${OUT_JSON}`);
}

main();
