#!/usr/bin/env node
/**
 * Builds a real, chart-derived ground-layout (runway threshold points +
 * taxiway polylines, correctly labeled and correctly oriented to true
 * north) for every airport, from the actual Treelon/ptfs-charts SVGs -
 * not guessed or invented.
 *
 * Method:
 * 1. Pull every text label's exact (x,y) position out of the chart SVG
 *    (resolving nested Inkscape <g transform> chains), in the chart's own
 *    local coordinate space.
 * 2. For each runway designator we already trust (data/charts/<ICAO>.json),
 *    find its heading-degree label (e.g. "106°") and the designator-text
 *    occurrence closest to it - that pairing is spatial, not order-based,
 *    so it survives charts with repeated/ambiguous plain-number labels
 *    (e.g. apron stand "10" vs. runway designator "10").
 * 3. Calibrate rotation+scale from the two resolved runway-threshold
 *    points against the REAL heading of the first designator, so every
 *    other label's position rotates into true-compass space correctly -
 *    this is what "correct orientation" is checked against, not the raw
 *    SVG's own (often rotated, non-north-up) drawing orientation.
 * 4. Group same-text taxiway labels (e.g. every "E" or every "D1") and
 *    chain them nearest-neighbor into a polyline - this is how a single
 *    taxiway repeatedly labeled along its length becomes one drawn line,
 *    and how a two-ended branch (labeled once at each end) becomes a stub.
 * 5. Connect each numbered connector label (E1, D2, L1, ...) to the
 *    nearest point on the reference runway centerline, since that's what
 *    a connector actually is.
 *
 * This is schematic (uniformly rescaled to a fixed on-screen diagram
 * size, same spirit as the existing runway-heading-line rendering) not
 * survey-accurate, but the letters/numbers and their relative arrangement
 * are the real ones from the real chart.
 *
 * Requires the `@xmldom/xmldom` package (not a runtime dependency of the
 * bot fleet - install it ad hoc, e.g. `npm install --no-save @xmldom/xmldom`
 * from a scratch directory, before running this).
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

// ---------- SVG parsing (same approach as extract-labels.js) ----------

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

function extractLabels(svgPath) {
  let xml = fs.readFileSync(svgPath, 'utf8');
  xml = xml.replace(/<image[\s\S]*?\/>/g, '<!-- image stripped -->');
  const doc = new DOMParser({ onError: () => {} }).parseFromString(xml, 'image/svg+xml');
  const out = [];
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
          out.push({ text, x: ax, y: ay });
        }
      }
    }
    for (let i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i], matrix);
  })(doc.documentElement, [1, 0, 0, 1, 0, 0]);
  return out;
}

// ---------- geometry helpers ----------

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Local "clock bearing": 0 = local up (-y), 90 = local right (+x), matching
// how compass bearings work (clockwise), just in the SVG's own frame.
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

// Real-world runway naming flips L<->R (and keeps C<->C) between reciprocal
// ends of the same physical strip - used to disambiguate parallel runways
// that share a heading pair (25L/25C/25R vs. 7L/7C/7R) where heading alone
// can't tell which pair is actually the same strip.
const RECIPROCAL_SUFFIX = { L: 'R', R: 'L', C: 'C', '': '' };
function splitDesignator(designator) {
  const m = /^(\d+)([LCR]?)$/.exec(designator);
  return m ? { num: m[1], suffix: m[2] } : { num: designator, suffix: '' };
}

// ---------- non-taxiway label noise to ignore ----------

const NON_TAXIWAY = new Set([
  'HS', 'N', 'HOT', 'SPOT', 'ATC', 'instructions.', 'clearance.',
]);

function isHotspotCode(text) {
  return /^HS\d*$/.test(text);
}

function isTaxiwayLabel(text) {
  if (isHotspotCode(text)) return false;
  if (NON_TAXIWAY.has(text)) return false;
  // Taxiway letters (A, B, ... single or double), optionally with a
  // connector number (D1, E12, L2). Excludes plain numbers (stand
  // numbers / runway designators, handled separately) and degree/length
  // tokens.
  return /^[A-Z]{1,2}\d{0,2}$/.test(text) && text.length <= 4;
}

// ---------- main per-airport processing ----------

function processAirport(icao, chart, svgPath) {
  const labels = extractLabels(svgPath);
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
    // A real threshold marker has its designator text right next to its
    // heading text on the chart; anything far away is a coincidental
    // same-text label elsewhere (e.g. an apron stand number).
    if (best && bestDist < 20) {
      resolved.push({ designator: rwy.designator, headingDeg: parseFloat(rwy.heading), point: best });
    }
  }

  if (resolved.length < 2) {
    return { icao, calibrated: false, reason: `only ${resolved.length} runway threshold(s) resolved`, points: {}, segments: [] };
  }

  // Pick the first genuinely reciprocal pair (headings ~180° apart) as the
  // calibration reference - NOT just the first two resolved thresholds,
  // since parallel runways (9L/9R, 25L/25C/25R) share the same heading and
  // would give a cross-track vector instead of an along-runway one.
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
    return { icao, calibrated: false, reason: 'no reciprocal runway-threshold pair resolved', points: {}, segments: [] };
  }
  const localHalf = dist(ref1.point, ref2.point) / 2;
  if (localHalf < 1e-6) {
    return { icao, calibrated: false, reason: 'degenerate runway threshold distance', points: {}, segments: [] };
  }
  const midpoint = { x: (ref1.point.x + ref2.point.x) / 2, y: (ref1.point.y + ref2.point.y) / 2 };
  const bearingLocal = localBearing(ref1.point, ref2.point);
  const rotationOffset = norm360(ref1.headingDeg - bearingLocal);
  const diagramScale = RUNWAY_HALF_LENGTH_NM / localHalf; // NM per local unit

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

  // Runway threshold points (for every resolved designator, not just the
  // calibration pair - useful for multi-runway airports like IIAB).
  const points = {};
  for (const r of resolved) {
    points[`RWY_${r.designator}`] = toNmOffset(r.point);
  }

  // Pair every resolved designator with its best reciprocal match (headings
  // ~180° apart) so the frontend can draw each physical runway as a real
  // threshold-to-threshold line instead of a fixed schematic length.
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
      // Prefer a correct suffix match; among those (or if none match at
      // all), fall back to smallest heading deviation.
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

  // Group taxiway-ish labels by exact text, keep local points for chaining.
  const groups = new Map();
  for (const l of labels) {
    if (!isTaxiwayLabel(l.text)) continue;
    if (!groups.has(l.text)) groups.set(l.text, []);
    groups.get(l.text).push(l);
  }

  const segments = [];
  for (const [text, occurrences] of groups) {
    // De-duplicate near-identical duplicate label glyphs (Inkscape often
    // stacks a text node and an outline copy at ~the same spot).
    const dedup = [];
    for (const occ of occurrences) {
      if (!dedup.some((d) => dist(d, occ) < 1)) dedup.push(occ);
    }
    let chain;
    if (dedup.length === 1) {
      chain = dedup;
    } else {
      // Nearest-neighbor chain through all occurrences of this label -
      // approximates the real taxiway centerline through its repeated labels.
      const remaining = dedup.slice();
      chain = [remaining.shift()];
      while (remaining.length) {
        const last = chain[chain.length - 1];
        let bestIdx = 0;
        let bestD = Infinity;
        remaining.forEach((p, i) => {
          const d = dist(last, p);
          if (d < bestD) {
            bestD = d;
            bestIdx = i;
          }
        });
        chain.push(remaining.splice(bestIdx, 1)[0]);
      }
      for (let i = 0; i + 1 < chain.length; i++) {
        segments.push({ label: text, a: toNmOffset(chain[i]), b: toNmOffset(chain[i + 1]) });
      }
    }
    points[text] = toNmOffset(chain[0]);

    // Connect whichever end of this taxiway's chain sits closest to the
    // runway centerline to its projection there - that's the physical link
    // a connector (or a lone branch taxiway like "A") represents. Skip if
    // the nearest approach is implausibly far (not actually this runway's
    // taxiway - e.g. a label that happens to collide with the pattern).
    let bestEnd = null;
    let bestProj = null;
    let bestEndDist = Infinity;
    for (const end of [chain[0], chain[chain.length - 1]]) {
      const proj = projectOntoSegment(end, ref1.point, ref2.point);
      if (!proj) continue;
      const d = dist(end, proj);
      if (d < bestEndDist) {
        bestEndDist = d;
        bestEnd = end;
        bestProj = proj;
      }
    }
    if (bestEnd && bestEndDist < localHalf * 0.6) {
      segments.push({ label: `${text}-rwy`, a: toNmOffset(bestEnd), b: toNmOffset(bestProj) });
    }
  }

  return {
    icao,
    calibrated: true,
    rotationOffsetDeg: rotationOffset,
    referenceRunway: [ref1.designator, ref2.designator],
    points,
    segments,
    runwayLines,
  };
}

function projectOntoSegment(p, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-9) return null;
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
  t = Math.max(0, Math.min(1, t));
  return { x: a.x + t * abx, y: a.y + t * aby };
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
      summary.push(`${chart.icao}: ${layout.calibrated ? `ok (${layout.segments.length} segments, ${Object.keys(layout.points).length} points, ref ${layout.referenceRunway.join('/')})` : `SKIPPED - ${layout.reason}`}`);
    } catch (err) {
      summary.push(`${chart.icao}: ERROR ${err.message}`);
    }
  }
  fs.writeFileSync(OUT_PATH, JSON.stringify(results) + '\n');
  console.log(summary.join('\n'));
  console.log(`\nWrote ${OUT_PATH}`);
}

main();
