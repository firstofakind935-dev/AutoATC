#!/usr/bin/env node
/**
 * Builds a real, chart-derived ground-layout (actual runway/taxiway/apron/
 * building line art, correctly oriented to true north) for every airport,
 * traced directly from the real Ground Chart SVGs (Treelon/ptfs-charts) -
 * not reconstructed from text label positions, and not invented.
 *
 * v1 of this tool reconstructed taxiway shapes by connecting text label
 * positions (nearest-neighbor chains between repeated "D"/"E1"/etc.
 * labels). That produced a topology guess, not the real chart shape - it
 * got connections wrong (e.g. straight-lining a taxiway to the runway when
 * it actually only reaches an adjacent taxiway) and could never draw the
 * real curves, loops, or apron/building outlines. This version instead
 * traces the chart's own vector line art directly.
 *
 * Method:
 * 1. Find the chart's main content border rect (the largest fill:none
 *    rect - every one of these charts draws one bordering the airport
 *    diagram, below the header/frequency-table strip) and use it to crop
 *    out header/table clutter.
 * 2. Extract every <path>/<rect>/<circle>/<ellipse> inside that border,
 *    flattening curves (C/S/Q/T bezier, A arcs) into point sequences, in
 *    the chart's own local coordinate space (resolving nested Inkscape
 *    <g transform> chains).
 * 3. Extract every text label's exact position the same way (as v1 did),
 *    and use runway designator/heading label pairs to calibrate rotation
 *    and scale against that runway's real known heading - this is what
 *    makes the orientation correct regardless of which way the original
 *    chart happened to be drawn (these are generally *not* north-up).
 * 4. Apply that same calibration transform to every traced shape, so the
 *    real line art - taxiway centerlines, apron/pavement outlines,
 *    buildings, hold markings, the runway's own drawn shape - ends up
 *    correctly rotated and positioned relative to the airport's real
 *    lat/lon, uniformly rescaled to a fixed on-screen diagram size (the
 *    real airports are all much smaller than the radar's per-station
 *    zoom, so true-to-scale would be sub-pixel).
 *
 * Requires the `@xmldom/xmldom` package (a devDependency - `npm install`
 * from the repo root pulls it in).
 *
 * Usage: node scripts/build-ground-layouts.js <path-to-cloned-ptfs-charts-repo>
 */
const fs = require('fs');
const path = require('path');
const { DOMParser } = require('@xmldom/xmldom');

const CHARTS_DIR = path.join(__dirname, '..', 'data', 'charts');
const SOURCE_ROOT = process.argv[2];
const OUT_PATH = path.join(__dirname, '..', 'monitor', 'public', 'groundlayouts.json');

if (!SOURCE_ROOT) {
  console.error('Usage: node scripts/build-ground-layouts.js <path-to-cloned-ptfs-charts-repo>');
  process.exit(1);
}

const RUNWAY_HALF_LENGTH_NM = 0.6; // must match monitor/public/radar.js

// ---------- 2D affine transform helpers (SVG matrix convention) ----------

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

// ---------- SVG path "d" parsing, flattened into polylines ----------
// Supports M/L/H/V/C/S/Q/T/Z (upper+lower). Arcs (A) are approximated as a
// straight line to the endpoint - rare in this hand-drawn chart line art
// (bends are drawn as cubic beziers), and a flattened chord is a harmless
// simplification if one does show up.

function parsePathD(d) {
  const tokens = d.match(/[MLHVCSQTAZmlhvcsqtaz]|-?\d*\.?\d+(?:e-?\d+)?/g) || [];
  let i = 0;
  const next = () => parseFloat(tokens[i++]);
  const subpaths = [];
  let cur = null;
  let cx = 0, cy = 0, startX = 0, startY = 0;
  let prevCtrl = null; // reflection control point for S/T
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
    cx = p3.x;
    cy = p3.y;
  }

  function quadBezier(p0, p1, p2) {
    for (let s = 1; s <= BEZIER_STEPS; s++) {
      const t = s / BEZIER_STEPS;
      const mt = 1 - t;
      const x = mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x;
      const y = mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y;
      cur.push({ x, y });
    }
    cx = p2.x;
    cy = p2.y;
  }

  while (i < tokens.length) {
    const tok = tokens[i];
    if (/[MLHVCSQTAZmlhvcsqtaz]/.test(tok)) {
      cmd = tok;
      i++;
    }
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();

    if (C === 'M') {
      if (cur) subpaths.push(cur);
      cur = [];
      const x = next(), y = next();
      const px = rel ? cx + x : x;
      const py = rel ? cy + y : y;
      pushPoint(px, py);
      startX = px;
      startY = py;
      prevCtrl = null;
      cmd = rel ? 'l' : 'L'; // subsequent coordinate pairs are implicit lineto
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
      next(); next(); next(); next(); next(); // rx, ry, x-axis-rotation, large-arc, sweep
      const x = next(), y = next();
      pushPoint(rel ? cx + x : x, rel ? cy + y : y);
      prevCtrl = null;
    } else if (C === 'Z') {
      pushPoint(startX, startY);
      prevCtrl = null;
    } else {
      i++; // unknown token - skip defensively rather than infinite-loop
    }
  }
  if (cur && cur.length) subpaths.push(cur);
  return subpaths;
}

// ---------- SVG walk: collect labels, shapes, and named rects ----------

function extractChart(svgPath) {
  let xml = fs.readFileSync(svgPath, 'utf8');
  xml = xml.replace(/<image[\s\S]*?\/>/g, '<!-- image stripped -->');
  const doc = new DOMParser({ onError: () => {} }).parseFromString(xml, 'image/svg+xml');

  const labels = [];
  const shapes = []; // { subpaths: [[{x,y},...], ...] }
  const rects = []; // { x, y, width, height } in document space (axis-aligned, transform-free rects only)

  (function walk(node, parentMatrix) {
    if (!node || node.nodeType !== 1) return;
    const tag = node.tagName;
    const matrix = multiply(parentMatrix, parseTransform(node.getAttribute && node.getAttribute('transform')));

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
    } else if (tag === 'path') {
      const d = node.getAttribute('d');
      if (d) {
        const subpaths = parsePathD(d).map((pts) => pts.map((p) => {
          const [ax, ay] = applyMatrix(matrix, p.x, p.y);
          return { x: ax, y: ay };
        }));
        shapes.push({ subpaths });
      }
    } else if (tag === 'rect') {
      const x = parseFloat(node.getAttribute('x') || '0');
      const y = parseFloat(node.getAttribute('y') || '0');
      const w = parseFloat(node.getAttribute('width') || '0');
      const h = parseFloat(node.getAttribute('height') || '0');
      const corners = [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]].map(([px, py]) => {
        const [ax, ay] = applyMatrix(matrix, px, py);
        return { x: ax, y: ay };
      });
      shapes.push({ subpaths: [corners] });
      // Only axis-aligned (unrotated) rects are candidates for the content
      // border - a transformed one (Inkscape uses these for small building
      // icons) isn't the page-level frame we're looking for.
      if (/^matrix\(1,0,0,1|^translate|^$/.test((node.getAttribute('transform') || '').trim()) || !node.getAttribute('transform')) {
        rects.push({ x: corners[0].x, y: corners[0].y, width: Math.abs(corners[2].x - corners[0].x), height: Math.abs(corners[2].y - corners[0].y), style: node.getAttribute('style') || '' });
      }
    } else if (tag === 'circle') {
      const cx = parseFloat(node.getAttribute('cx') || '0');
      const cy = parseFloat(node.getAttribute('cy') || '0');
      const r = parseFloat(node.getAttribute('r') || '0');
      const pts = [];
      const STEPS = 16;
      for (let s = 0; s <= STEPS; s++) {
        const a = (s / STEPS) * Math.PI * 2;
        const [ax, ay] = applyMatrix(matrix, cx + r * Math.cos(a), cy + r * Math.sin(a));
        pts.push({ x: ax, y: ay });
      }
      shapes.push({ subpaths: [pts] });
    } else if (tag === 'ellipse') {
      const cx = parseFloat(node.getAttribute('cx') || '0');
      const cy = parseFloat(node.getAttribute('cy') || '0');
      const rx = parseFloat(node.getAttribute('rx') || '0');
      const ry = parseFloat(node.getAttribute('ry') || '0');
      const pts = [];
      const STEPS = 16;
      for (let s = 0; s <= STEPS; s++) {
        const a = (s / STEPS) * Math.PI * 2;
        const [ax, ay] = applyMatrix(matrix, cx + rx * Math.cos(a), cy + ry * Math.sin(a));
        pts.push({ x: ax, y: ay });
      }
      shapes.push({ subpaths: [pts] });
    }

    for (let i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i], matrix);
  })(doc.documentElement, [1, 0, 0, 1, 0, 0]);

  return { labels, shapes, rects };
}

// ---------- geometry helpers ----------

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function localBearing(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  let deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  return deg;
}

function norm360(deg) {
  let d = deg % 360;
  if (d < 0) d += 360;
  return d;
}

const RECIPROCAL_SUFFIX = { L: 'R', R: 'L', C: 'C', '': '' };
function splitDesignator(designator) {
  const m = /^(\d+)([LCR]?)$/.exec(designator);
  return m ? { num: m[1], suffix: m[2] } : { num: designator, suffix: '' };
}

// ---------- taxiway-label filtering ----------
// Real chart labels are read straight off the chart for display, same as
// runway designators - this is just picking which text tokens are taxiway
// letters/connectors (as opposed to stand numbers, degree headings, length
// callouts, or hot-spot circle codes) to draw on the traced diagram, not a
// topology guess like the label-position reconstruction this replaced.

function isHotspotCode(text) {
  return /^HS\d*$/.test(text);
}

function isTaxiwayLabel(text) {
  if (isHotspotCode(text)) return false;
  if (text === 'N') return false; // compass rose marker
  // Taxiway letters (single or double), optionally with a connector
  // number (D1, E12, L2). Excludes plain numbers (stand numbers / runway
  // designators, handled separately) and degree/length tokens.
  return /^[A-Z]{1,2}\d{0,2}$/.test(text) && text.length <= 4;
}

// ---------- main per-airport processing ----------

function processAirport(icao, chart, svgPath) {
  const { labels, shapes, rects } = extractChart(svgPath);
  const runways = Array.isArray(chart.runways) ? chart.runways : [];

  // Resolve each runway designator to a real (x,y): find its heading text,
  // then the nearest occurrence of the designator text to that heading text.
  const resolved = [];
  for (const rwy of runways) {
    if (!rwy.designator || !rwy.heading) continue;
    const headingLabels = labels.filter((l) => l.text === rwy.heading);
    const designatorLabels = labels.filter((l) => l.text === rwy.designator);
    if (!headingLabels.length || !designatorLabels.length) continue;
    let best = null;
    let bestDist = Infinity;
    for (const h of headingLabels) {
      for (const d of designatorLabels) {
        const dd = dist(h, d);
        if (dd < bestDist) {
          bestDist = dd;
          best = d;
        }
      }
    }
    if (best && bestDist < 20) {
      resolved.push({ designator: rwy.designator, headingDeg: parseFloat(rwy.heading), point: best });
    }
  }

  if (resolved.length < 2) {
    return { icao, calibrated: false, reason: `only ${resolved.length} runway threshold(s) resolved` };
  }

  let ref1 = null;
  let ref2 = null;
  let refSuffixMatch = false;
  for (let i = 0; i < resolved.length; i++) {
    const iParts = splitDesignator(resolved[i].designator);
    for (let j = 0; j < resolved.length; j++) {
      if (i === j) continue;
      const diff = Math.abs(norm360(resolved[i].headingDeg - resolved[j].headingDeg - 180));
      if (diff >= 10 && diff <= 350) continue;
      const jParts = splitDesignator(resolved[j].designator);
      const suffixMatch = RECIPROCAL_SUFFIX[iParts.suffix] === jParts.suffix;
      if (!ref1 || (suffixMatch && !refSuffixMatch)) {
        ref1 = resolved[i];
        ref2 = resolved[j];
        refSuffixMatch = suffixMatch;
      }
    }
  }
  if (!ref1) {
    return { icao, calibrated: false, reason: 'no reciprocal runway-threshold pair resolved' };
  }
  const localHalf = dist(ref1.point, ref2.point) / 2;
  if (localHalf < 1e-6) {
    return { icao, calibrated: false, reason: 'degenerate runway threshold distance' };
  }
  const midpoint = { x: (ref1.point.x + ref2.point.x) / 2, y: (ref1.point.y + ref2.point.y) / 2 };
  const bearingLocal = localBearing(ref1.point, ref2.point);
  const rotationOffset = norm360(ref1.headingDeg - bearingLocal);
  const diagramScale = RUNWAY_HALF_LENGTH_NM / localHalf;

  function toNmOffset(pt) {
    const dx = pt.x - midpoint.x;
    const dy = pt.y - midpoint.y;
    const localDist = Math.hypot(dx, dy);
    if (localDist < 1e-9) return { north: 0, east: 0 };
    const bearingDeg = norm360(localBearing(midpoint, pt) + rotationOffset);
    const nm = localDist * diagramScale;
    const rad = (bearingDeg * Math.PI) / 180;
    return { north: nm * Math.cos(rad), east: nm * Math.sin(rad) };
  }

  const points = {};
  for (const r of resolved) points[`RWY_${r.designator}`] = toNmOffset(r.point);

  // Runway pairing for drawing threshold-to-threshold reference lines
  // (used as a fallback label anchor only now - the real runway shape
  // comes from the traced paths below).
  const runwayLines = [];
  const usedInLine = new Set();
  for (let i = 0; i < resolved.length; i++) {
    if (usedInLine.has(i)) continue;
    const iParts = splitDesignator(resolved[i].designator);
    let bestJ = -1;
    let bestDiff = Infinity;
    let bestSuffixMatch = false;
    for (let j = 0; j < resolved.length; j++) {
      if (i === j || usedInLine.has(j)) continue;
      const diff = Math.abs(norm360(resolved[i].headingDeg - resolved[j].headingDeg - 180));
      const wrapped = Math.min(diff, Math.abs(360 - diff));
      if (wrapped >= 10) continue;
      const jParts = splitDesignator(resolved[j].designator);
      const suffixMatch = RECIPROCAL_SUFFIX[iParts.suffix] === jParts.suffix;
      if (suffixMatch && !bestSuffixMatch) {
        bestJ = j;
        bestDiff = wrapped;
        bestSuffixMatch = true;
      } else if (suffixMatch === bestSuffixMatch && wrapped < bestDiff) {
        bestJ = j;
        bestDiff = wrapped;
      }
    }
    if (bestJ !== -1) {
      runwayLines.push([resolved[i].designator, resolved[bestJ].designator]);
      usedInLine.add(i);
      usedInLine.add(bestJ);
    }
  }

  // Find the main content border - the largest fill:none rect (every one
  // of these charts frames the airport diagram this way, below the
  // header/frequency-table strip) - and use it to crop out header clutter.
  const borderCandidates = rects
    .filter((r) => /fill:\s*none/.test(r.style) && r.width > 20 && r.height > 20)
    .sort((a, b) => b.width * b.height - a.width * a.height);
  const border = borderCandidates[0] || null;
  const margin = 2; // local units of slack around the border
  const bbox = border
    ? { minX: border.x - margin, minY: border.y - margin, maxX: border.x + border.width + margin, maxY: border.y + border.height + margin }
    : null;

  function insideBbox(pt) {
    if (!bbox) return true;
    return pt.x >= bbox.minX && pt.x <= bbox.maxX && pt.y >= bbox.minY && pt.y <= bbox.maxY;
  }

  // Taxiway letter/connector labels, read straight off the chart - kept as
  // every real occurrence (the real charts repeat a taxiway's letter
  // periodically along its length so it's identifiable from a glance at
  // any point), not deduplicated to one label per taxiway. Near-identical
  // stacked duplicates (Inkscape sometimes doubles a text node with an
  // outline copy at ~the same spot) are collapsed.
  const taxiwayLabels = [];
  const seenTaxiwayPoints = [];
  for (const l of labels) {
    if (!isTaxiwayLabel(l.text) || !insideBbox(l)) continue;
    if (seenTaxiwayPoints.some((s) => s.text === l.text && dist(s, l) < 1)) continue;
    seenTaxiwayPoints.push({ text: l.text, x: l.x, y: l.y });
    taxiwayLabels.push({ text: l.text, ...toNmOffset(l) });
  }

  // Trace every shape whose points fall inside the content border (minus
  // the border rect itself, which would otherwise draw a big frame).
  const tracedPaths = [];
  for (const shape of shapes) {
    for (const sub of shape.subpaths) {
      if (sub.length < 2) continue;
      const allInside = sub.every(insideBbox);
      if (!allInside) continue;
      // Skip anything that's essentially the border rect itself (same
      // bounding box, 4-5 points, axis aligned).
      if (border) {
        const minX = Math.min(...sub.map((p) => p.x));
        const maxX = Math.max(...sub.map((p) => p.x));
        const minY = Math.min(...sub.map((p) => p.y));
        const maxY = Math.max(...sub.map((p) => p.y));
        const isBorderItself =
          sub.length <= 5 &&
          Math.abs(minX - border.x) < 1 &&
          Math.abs(maxX - (border.x + border.width)) < 1 &&
          Math.abs(minY - border.y) < 1 &&
          Math.abs(maxY - (border.y + border.height)) < 1;
        if (isBorderItself) continue;
      }
      tracedPaths.push(sub.map(toNmOffset));
    }
  }

  return {
    icao,
    calibrated: true,
    rotationOffsetDeg: rotationOffset,
    referenceRunway: [ref1.designator, ref2.designator],
    points,
    runwayLines,
    tracedPaths,
    taxiwayLabels,
  };
}

// ---------- driver ----------

function main() {
  const files = fs.readdirSync(CHARTS_DIR).filter((f) => f.endsWith('.json'));
  const results = {};
  const summary = [];
  for (const f of files) {
    const chart = JSON.parse(fs.readFileSync(path.join(CHARTS_DIR, f), 'utf8'));
    if (!chart.icao || !chart.sourceFile) continue;
    const svgPath = path.join(SOURCE_ROOT, chart.sourceFile);
    if (!fs.existsSync(svgPath)) {
      summary.push(`${chart.icao}: MISSING SOURCE ${svgPath}`);
      continue;
    }
    try {
      const layout = processAirport(chart.icao, chart, svgPath);
      results[chart.icao] = layout;
      summary.push(`${chart.icao}: ${layout.calibrated ? `ok (${layout.tracedPaths.length} traced shapes, ${layout.taxiwayLabels.length} taxiway labels, ref ${layout.referenceRunway.join('/')})` : `SKIPPED - ${layout.reason}`}`);
    } catch (err) {
      summary.push(`${chart.icao}: ERROR ${err.stack || err.message}`);
    }
  }
  fs.writeFileSync(OUT_PATH, JSON.stringify(results) + '\n');
  console.log(summary.join('\n'));
  console.log(`\nWrote ${OUT_PATH}`);
}

main();
