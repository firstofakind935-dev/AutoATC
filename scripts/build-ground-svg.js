#!/usr/bin/env node
/**
 * Builds a real, chart-derived maps/<ICAO>/GROUND.svg - the format
 * monitor/public/radar24/src/main.js's loadGroundChartSVG() and
 * loadAirportData() both expect: three named layer groups
 * (Taxiway Lines / Taxiways / Ramps / Runways / Buildings) with real
 * runway/taxiway/apron line art, traced directly from the chart's own
 * vector paths (not reconstructed from label positions).
 *
 * Unlike scripts/build-ground-layouts.js (which flattens every shape
 * into one undifferentiated list and writes a JSON blob nothing reads),
 * this reads the chart's own named layers directly - the source charts
 * already group their content as "Runways / Buildings", "Taxiways /
 * Aprons" and "Taxiway Lines" (Inkscape layers), which line up with
 * what the renderer wants almost exactly.
 *
 * Calibration (rotation, scale) uses the same reciprocal-runway-
 * threshold method as build-ground-layouts.js: find each runway's
 * designator/heading label pair on the chart, use the real known
 * heading of two reciprocal thresholds to solve for rotation and
 * scale, and express every traced point as a real distance/bearing
 * (in NM) from the runway midpoint. Those NM offsets are then placed
 * in the *same* world-coordinate space coast.svg/boundaries.svg use
 * (STUDS_PER_NM studs per NM, /100 to match those files' own unit),
 * anchored at the airport's existing GroundOffsets.js x/y - so the
 * main map's ground-outline overlay (which draws GROUND.svg's raw
 * path coordinates directly into that shared world space, no extra
 * transform) lines up at the airport's real position, correctly
 * scaled and oriented, even though that anchor position itself is
 * only as accurate as whatever's already in GroundOffsets.js.
 *
 * Usage: node scripts/build-ground-svg.js <ICAO> <path-to-cloned-ptfs-charts-repo>
 */
const fs = require('fs');
const path = require('path');
const { DOMParser } = require('@xmldom/xmldom');

const ICAO = process.argv[2];
const SOURCE_ROOT = process.argv[3];
const STUDS_PER_NM = 3307.14286; // matches monitor/public/radar24/src/main.js's own constant
const NM_TO_UNITS = STUDS_PER_NM / 100;

if (!ICAO || !SOURCE_ROOT) {
  console.error('Usage: node scripts/build-ground-svg.js <ICAO> <path-to-cloned-ptfs-charts-repo>');
  process.exit(1);
}

const CHARTS_DIR = path.join(__dirname, '..', 'data', 'charts');
const OUT_DIR = path.join(__dirname, '..', 'monitor', 'public', 'radar24', 'public', 'assets', 'maps', ICAO);
const GROUND_OFFSETS_FILES = [
  path.join(__dirname, '..', 'monitor', 'public', 'radar24', 'src', 'data', 'GroundOffsets.js'),
  path.join(__dirname, '..', 'src', 'flightradar365', 'groundOffsets.js'),
];

// ---------- 2D affine transform helpers (SVG matrix convention) - copied
// from build-ground-layouts.js, unchanged ----------

function parseTransform(str) {
  let m = [1, 0, 0, 1, 0, 0];
  if (!str) return m;
  const re = /(translate|matrix|rotate|scale)\(([^)]*)\)/g;
  let match;
  while ((match = re.exec(str))) {
    const nums = match[2].trim().split(/[\s,]+/).map(Number);
    let t;
    if (match[1] === 'translate') t = [1, 0, 0, 1, nums[0] || 0, nums[1] || 0];
    else if (match[1] === 'matrix') t = nums;
    else if (match[1] === 'scale') {
      const sx = nums[0];
      const sy = nums.length > 1 ? nums[1] : sx;
      t = [sx, 0, 0, sy, 0, 0];
    } else if (match[1] === 'rotate') {
      const deg = nums[0];
      const rad = (deg * Math.PI) / 180;
      const cos = Math.cos(rad), sin = Math.sin(rad);
      if (nums.length >= 3) {
        const [, cx, cy] = nums;
        t = multiply([1, 0, 0, 1, cx, cy], multiply([cos, sin, -sin, cos, 0, 0], [1, 0, 0, 1, -cx, -cy]));
      } else {
        t = [cos, sin, -sin, cos, 0, 0];
      }
    }
    m = multiply(m, t);
  }
  return m;
}

function multiply(m1, m2) {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + c1 * b2, b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2, b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1, b1 * e2 + d1 * f2 + f1,
  ];
}

function applyMatrix(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function parsePathD(d) {
  const tokens = d.match(/[MLHVCSQTAZmlhvcsqtaz]|-?\d*\.?\d+(?:e-?\d+)?/g) || [];
  let i = 0;
  const next = () => parseFloat(tokens[i++]);
  const subpaths = [];
  let cur = null;
  let cx = 0, cy = 0, startX = 0, startY = 0;
  let prevCtrl = null;
  let cmd = null;
  const BEZIER_STEPS = 8;

  function pushPoint(x, y) {
    cur.push({ x, y });
    cx = x;
    cy = y;
  }
  function cubicBezier(p0, p1, p2, p3) {
    for (let s = 1; s <= BEZIER_STEPS; s++) {
      const t = s / BEZIER_STEPS;
      const mt = 1 - t;
      const x = mt * mt * mt * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t * t * t * p3.x;
      const y = mt * mt * mt * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t * t * t * p3.y;
      cur.push({ x, y });
    }
    cx = p3.x; cy = p3.y;
  }
  function quadBezier(p0, p1, p2) {
    for (let s = 1; s <= BEZIER_STEPS; s++) {
      const t = s / BEZIER_STEPS;
      const mt = 1 - t;
      const x = mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x;
      const y = mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y;
      cur.push({ x, y });
    }
    cx = p2.x; cy = p2.y;
  }

  while (i < tokens.length) {
    const tok = tokens[i];
    if (/[MLHVCSQTAZmlhvcsqtaz]/.test(tok)) { cmd = tok; i++; }
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();

    if (C === 'M') {
      if (cur) subpaths.push(cur);
      cur = [];
      const x = next(), y = next();
      const px = rel ? cx + x : x;
      const py = rel ? cy + y : y;
      pushPoint(px, py);
      startX = px; startY = py;
      prevCtrl = null;
      cmd = rel ? 'l' : 'L';
    } else if (C === 'L') {
      const x = next(), y = next();
      pushPoint(rel ? cx + x : x, rel ? cy + y : y);
      prevCtrl = null;
    } else if (C === 'H') {
      const x = next();
      pushPoint(rel ? cx + x : x, cy);
      prevCtrl = null;
    } else if (C === 'V') {
      const y = next();
      pushPoint(cx, rel ? cy + y : y);
      prevCtrl = null;
    } else if (C === 'C') {
      const x1 = next(), y1 = next(), x2 = next(), y2 = next(), x = next(), y = next();
      const p0 = { x: cx, y: cy };
      const p1 = { x: rel ? cx + x1 : x1, y: rel ? cy + y1 : y1 };
      const p2 = { x: rel ? cx + x2 : x2, y: rel ? cy + y2 : y2 };
      const p3 = { x: rel ? cx + x : x, y: rel ? cy + y : y };
      cubicBezier(p0, p1, p2, p3);
      prevCtrl = p2;
    } else if (C === 'S') {
      const x2 = next(), y2 = next(), x = next(), y = next();
      const p0 = { x: cx, y: cy };
      const p1 = prevCtrl ? { x: 2 * cx - prevCtrl.x, y: 2 * cy - prevCtrl.y } : p0;
      const p2 = { x: rel ? cx + x2 : x2, y: rel ? cy + y2 : y2 };
      const p3 = { x: rel ? cx + x : x, y: rel ? cy + y : y };
      cubicBezier(p0, p1, p2, p3);
      prevCtrl = p2;
    } else if (C === 'Q') {
      const x1 = next(), y1 = next(), x = next(), y = next();
      const p0 = { x: cx, y: cy };
      const p1 = { x: rel ? cx + x1 : x1, y: rel ? cy + y1 : y1 };
      const p2 = { x: rel ? cx + x : x, y: rel ? cy + y : y };
      quadBezier(p0, p1, p2);
      prevCtrl = p1;
    } else if (C === 'T') {
      const x = next(), y = next();
      const p0 = { x: cx, y: cy };
      const p1 = prevCtrl ? { x: 2 * cx - prevCtrl.x, y: 2 * cy - prevCtrl.y } : p0;
      const p2 = { x: rel ? cx + x : x, y: rel ? cy + y : y };
      quadBezier(p0, p1, p2);
      prevCtrl = p1;
    } else if (C === 'A') {
      next(); next(); next(); next(); next();
      const x = next(), y = next();
      pushPoint(rel ? cx + x : x, rel ? cy + y : y);
      prevCtrl = null;
    } else if (C === 'Z') {
      pushPoint(startX, startY);
      prevCtrl = null;
    } else {
      i++;
    }
  }
  if (cur && cur.length) subpaths.push(cur);
  return subpaths;
}

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function localBearing(from, to) {
  const dx = to.x - from.x, dy = to.y - from.y;
  let deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  return deg;
}
function norm360(deg) { let d = deg % 360; if (d < 0) d += 360; return d; }
const RECIPROCAL_SUFFIX = { L: 'R', R: 'L', C: 'C', '': '' };
function splitDesignator(designator) {
  const m = /^(\d+)([LCR]?)$/.exec(designator);
  return m ? { num: m[1], suffix: m[2] } : { num: designator, suffix: '' };
}

// ---------- layer-aware extraction ----------
// Walks the tree tracking which named Inkscape layer (if any) each node is
// under, and collects labels/shapes per layer, plus a flat label list for
// calibration.

const WANTED_LAYERS = {
  'Runways / Buildings': 'runwaysBuildings',
  'Taxiways / Aprons': 'taxiwaysRamps', // -> "Taxiways / Ramps" in the renderer
  'Taxiway Lines': 'taxiwayLines',
};

function extractChart(svgPath) {
  let xml = fs.readFileSync(svgPath, 'utf8');
  xml = xml.replace(/<image[\s\S]*?\/>/g, '<!-- image stripped -->');
  const doc = new DOMParser({ onError: () => {} }).parseFromString(xml, 'image/svg+xml');

  const labels = [];
  const layerShapes = { runwaysBuildings: [], taxiwaysRamps: [], taxiwayLines: [] };

  function shapeFromPath(node, matrix) {
    const d = node.getAttribute('d');
    if (!d) return null;
    return parsePathD(d).map((pts) => pts.map((p) => {
      const [ax, ay] = applyMatrix(matrix, p.x, p.y);
      return { x: ax, y: ay };
    }));
  }
  function shapeFromRect(node, matrix) {
    const x = parseFloat(node.getAttribute('x') || '0');
    const y = parseFloat(node.getAttribute('y') || '0');
    const w = parseFloat(node.getAttribute('width') || '0');
    const h = parseFloat(node.getAttribute('height') || '0');
    return [[[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]].map(([px, py]) => {
      const [ax, ay] = applyMatrix(matrix, px, py);
      return { x: ax, y: ay };
    })];
  }
  function shapeFromEllipse(node, matrix, isCircle) {
    const cx = parseFloat(node.getAttribute('cx') || '0');
    const cy = parseFloat(node.getAttribute('cy') || '0');
    const rx = isCircle ? parseFloat(node.getAttribute('r') || '0') : parseFloat(node.getAttribute('rx') || '0');
    const ry = isCircle ? rx : parseFloat(node.getAttribute('ry') || '0');
    const pts = [];
    const STEPS = 16;
    for (let s = 0; s <= STEPS; s++) {
      const a = (s / STEPS) * Math.PI * 2;
      const [ax, ay] = applyMatrix(matrix, cx + rx * Math.cos(a), cy + ry * Math.sin(a));
      pts.push({ x: ax, y: ay });
    }
    return [pts];
  }

  (function walk(node, parentMatrix, currentLayer) {
    if (!node || node.nodeType !== 1) return;
    const tag = node.tagName;
    const matrix = multiply(parentMatrix, parseTransform(node.getAttribute && node.getAttribute('transform')));

    let layer = currentLayer;
    if (tag === 'g') {
      const label = node.getAttribute('inkscape:label');
      if (label && WANTED_LAYERS[label]) layer = WANTED_LAYERS[label];
      else if (label) layer = null; // entered a named layer we don't want (Screenshot/Layout/Labels/Guides) - don't inherit an outer wanted layer into it
    }

    if (tag === 'text' || tag === 'tspan') {
      const xAttr = node.getAttribute('x');
      const yAttr = node.getAttribute('y');
      if (xAttr !== null && yAttr !== null) {
        const x = parseFloat(xAttr.split(/[\s,]+/)[0]);
        const y = parseFloat(yAttr.split(/[\s,]+/)[0]);
        let text = '';
        for (let i = 0; i < node.childNodes.length; i++) {
          const c = node.childNodes[i];
          if (c.nodeType === 3) text += c.nodeValue;
        }
        text = text.trim();
        if (text && !Number.isNaN(x) && !Number.isNaN(y)) {
          const [ax, ay] = applyMatrix(matrix, x, y);
          labels.push({ text, x: ax, y: ay });
        }
      }
    } else if (layer && tag === 'path') {
      const sp = shapeFromPath(node, matrix);
      if (sp) layerShapes[layer].push(...sp);
    } else if (layer && tag === 'rect') {
      layerShapes[layer].push(...shapeFromRect(node, matrix));
    } else if (layer && (tag === 'circle' || tag === 'ellipse')) {
      layerShapes[layer].push(...shapeFromEllipse(node, matrix, tag === 'circle'));
    }

    for (let i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i], matrix, layer);
  })(doc.documentElement, [1, 0, 0, 1, 0, 0], null);

  return { labels, layerShapes };
}

// ---------- calibration (same method as build-ground-layouts.js) ----------

function calibrate(labels, runways) {
  const resolved = [];
  for (const rwy of runways) {
    if (!rwy.designator || !rwy.heading) continue;
    const headingText = rwy.heading.replace('°', '');
    const headingLabels = labels.filter((l) => l.text === headingText || l.text === rwy.heading);
    const designatorLabels = labels.filter((l) => l.text === rwy.designator);
    if (!headingLabels.length || !designatorLabels.length) continue;
    let best = null, bestDist = Infinity;
    for (const h of headingLabels) {
      for (const d of designatorLabels) {
        const dd = dist(h, d);
        if (dd < bestDist) { bestDist = dd; best = d; }
      }
    }
    if (best && bestDist < 20) {
      resolved.push({ designator: rwy.designator, headingDeg: parseFloat(headingText), point: best });
    }
  }
  if (resolved.length < 2) throw new Error(`only ${resolved.length} runway threshold(s) resolved`);

  let ref1 = null, ref2 = null, refSuffixMatch = false;
  for (let i = 0; i < resolved.length; i++) {
    const iParts = splitDesignator(resolved[i].designator);
    for (let j = 0; j < resolved.length; j++) {
      if (i === j) continue;
      const diff = Math.abs(norm360(resolved[i].headingDeg - resolved[j].headingDeg - 180));
      if (diff >= 10 && diff <= 350) continue;
      const jParts = splitDesignator(resolved[j].designator);
      const suffixMatch = RECIPROCAL_SUFFIX[iParts.suffix] === jParts.suffix;
      if (!ref1 || (suffixMatch && !refSuffixMatch)) { ref1 = resolved[i]; ref2 = resolved[j]; refSuffixMatch = suffixMatch; }
    }
  }
  if (!ref1) throw new Error('no reciprocal runway-threshold pair resolved');

  const localHalf = dist(ref1.point, ref2.point) / 2;
  if (localHalf < 1e-6) throw new Error('degenerate runway threshold distance');
  const midpoint = { x: (ref1.point.x + ref2.point.x) / 2, y: (ref1.point.y + ref2.point.y) / 2 };
  const bearingLocal = localBearing(ref1.point, ref2.point);
  const rotationOffset = norm360(ref1.headingDeg - bearingLocal);

  function toNmOffset(pt, halfNm) {
    const dx = pt.x - midpoint.x, dy = pt.y - midpoint.y;
    const localDist = Math.hypot(dx, dy);
    if (localDist < 1e-9) return { north: 0, east: 0 };
    const bearingDeg = norm360(localBearing(midpoint, pt) + rotationOffset);
    const nm = (localDist / localHalf) * halfNm;
    const rad = (bearingDeg * Math.PI) / 180;
    return { north: nm * Math.cos(rad), east: nm * Math.sin(rad) };
  }

  return { ref1, ref2, midpoint, rotationOffset, toNmOffset, resolved };
}

// ---------- SVG output ----------

function serializePath(subpath) {
  return subpath.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(3)} ${p.y.toFixed(3)}`).join('') ;
}

function main() {
  const chart = JSON.parse(fs.readFileSync(path.join(CHARTS_DIR, `${ICAO}.json`), 'utf8'));
  const svgPath = path.join(SOURCE_ROOT, chart.sourceFile);
  if (!fs.existsSync(svgPath)) {
    console.error(`Source chart not found: ${svgPath}`);
    process.exit(1);
  }

  const { labels, layerShapes } = extractChart(svgPath);
  console.log(`Extracted ${labels.length} labels, ${layerShapes.runwaysBuildings.length} runway/building shapes, ${layerShapes.taxiwaysRamps.length} taxiway/apron shapes, ${layerShapes.taxiwayLines.length} taxiway-line shapes`);

  // Runway half-length in NM, from the real known length of the reference
  // runway pair if the chart data has it, else the build-ground-layouts.js
  // default of 0.6 NM (drawn at a fixed on-screen size rather than true
  // scale, same as every other airport here).
  const cal = calibrate(labels, chart.runways);
  let halfNm = 0.6;
  const ref1Data = chart.runways.find((r) => r.designator === cal.ref1.designator);
  if (ref1Data && ref1Data.length && ref1Data.length.meters) {
    const meters = parseFloat(ref1Data.length.meters);
    if (!Number.isNaN(meters)) halfNm = (meters / 1852) / 2;
  }
  console.log(`Reference runway ${cal.ref1.designator}/${cal.ref2.designator}, half-length ${halfNm.toFixed(4)} NM, rotation offset ${cal.rotationOffset.toFixed(2)}deg`);

  // Load the airport's existing world anchor (x, y) from GroundOffsets.js.
  const groundOffsetsSrc = fs.readFileSync(GROUND_OFFSETS_FILES[0], 'utf8');
  const anchorMatch = new RegExp(`["']?${ICAO}["']?:\\s*\\{[^}]*x:\\s*(-?[\\d.]+),\\s*y:\\s*(-?[\\d.]+)`).exec(groundOffsetsSrc);
  if (!anchorMatch) {
    console.error(`Could not find an existing ${ICAO} entry in ${GROUND_OFFSETS_FILES[0]}`);
    process.exit(1);
  }
  const anchor = { x: parseFloat(anchorMatch[1]), y: parseFloat(anchorMatch[2]) };
  console.log(`Anchoring at existing GroundOffsets.js position: x=${anchor.x}, y=${anchor.y}`);

  // The Ground View tab's initial camera (see main.js's "screen center the
  // SVG" / "zoom in or out") uses this same x/y as the viewBox's top-left
  // corner, not its center - so the diagram is placed with a small margin
  // *below and to the right* of the anchor rather than centered on it, or
  // content to the anchor's left/above would be permanently unreachable on
  // load (viewBox only extends right/down from x/y) regardless of zoom.
  // The main map's ground-outline overlay (loadAirportData) draws these
  // same coordinates directly, so the outline ends up anchored at the
  // airport's real position by its own top-left corner instead of its
  // center - a real but minor trade-off, and the one this codebase's
  // shared x/y field already forces on every airport.
  const FRAME_MARGIN = 5; // world units
  function rawWorld(pt) {
    const { north, east } = cal.toNmOffset(pt, halfNm);
    return { x: east * NM_TO_UNITS, y: -north * NM_TO_UNITS }; // relative to the runway midpoint at (0,0)
  }
  function allShapes() {
    return [...layerShapes.runwaysBuildings, ...layerShapes.taxiwaysRamps, ...layerShapes.taxiwayLines];
  }
  const rawPoints = allShapes().flatMap((sp) => sp.map(rawWorld));
  const minRawX = Math.min(...rawPoints.map((p) => p.x));
  const minRawY = Math.min(...rawPoints.map((p) => p.y));
  const offsetX = anchor.x + FRAME_MARGIN - minRawX;
  const offsetY = anchor.y + FRAME_MARGIN - minRawY;

  function toWorld(pt) {
    const raw = rawWorld(pt);
    return { x: raw.x + offsetX, y: raw.y + offsetY };
  }

  function buildLayerGroup(label, id, shapes) {
    const paths = shapes
      .filter((sp) => sp.length >= 2)
      .map((sp) => `<path d="${serializePath(sp.map(toWorld))}" id="${id}-${Math.random().toString(36).slice(2, 9)}"/>`)
      .join('');
    return `<g inkscape:label="${label}" id="${id}">${paths}</g>`;
  }

  const svg = `<svg xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns="http://www.w3.org/2000/svg" width="963.54999" height="920.03003" viewBox="0 0 963.54999 920.03003" fill="none" version="1.1" id="svg-${ICAO}">` +
    buildLayerGroup('Runways / Buildings', 'layer-runways', layerShapes.runwaysBuildings) +
    buildLayerGroup('Taxiways / Ramps', 'layer-taxiways', layerShapes.taxiwaysRamps) +
    buildLayerGroup('Taxiway Lines', 'layer-taxiway-lines', layerShapes.taxiwayLines) +
    `</svg>`;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'GROUND.svg'), svg);
  console.log(`Wrote ${path.join(OUT_DIR, 'GROUND.svg')}`);

  // Print the content's world-space extent, and a suggested zoom for the
  // dedicated Ground View tab's default framing. That tab (see
  // fetchMapLayerGround/loadGroundChartSVG in main.js) loads coast.svg
  // FIRST as its base layer and runs getBBox() on THAT - i.e. the *whole
  // world's* extent, not this airport's own content - then overrides the
  // resulting viewBox with GroundOffsets.js's x/y (used as-is, the
  // viewBox's top-left corner - already satisfied by this script's own
  // FRAME_MARGIN placement above) and multiplies width/height by `zoom`.
  // So `zoom` has to be chosen relative to coast.svg's full extent, not
  // this diagram's own size: zoom ~= (desired view width) / (coast.svg's
  // full width) - anything close to 1 (this content's own natural scale)
  // will show nearly the entire world map instead of a close-up.
  const allPts = [...layerShapes.runwaysBuildings, ...layerShapes.taxiwaysRamps, ...layerShapes.taxiwayLines].flat().map(toWorld);
  const xs = allPts.map((p) => p.x), ys = allPts.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = maxX - minX, spanY = maxY - minY;
  console.log(`Content world bbox: x ${minX.toFixed(2)}..${maxX.toFixed(2)}, y ${minY.toFixed(2)}..${maxY.toFixed(2)} (span ${spanX.toFixed(2)} x ${spanY.toFixed(2)})`);
  const COAST_SVG_WORLD_SPAN = 963.55; // monitor/public/radar24/public/assets/coast.svg's declared width/height
  const suggestedZoom = (Math.max(spanX, spanY) * 1.3) / COAST_SVG_WORLD_SPAN; // +30% margin
  console.log(`Suggested GroundOffsets.js zoom for the Ground View tab: ${suggestedZoom.toFixed(4)} (x/y stay as the existing anchor)`);
}

main();
