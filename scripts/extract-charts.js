#!/usr/bin/env node
/**
 * One-off/re-runnable extraction tool: parses Ground Chart SVGs from the
 * community PTFS Charts repo (https://github.com/Treelon/ptfs-charts,
 * CC-BY-SA-4.0) into small per-airport JSON reference files under
 * data/charts/, so the bot can ground taxi/runway instructions in real
 * chart data instead of inventing taxiway names and frequencies.
 *
 * This is a build-time tool, not part of the bot's runtime - re-run it
 * manually if the source charts repo gets updated.
 *
 * Usage: node scripts/extract-charts.js <path-to-cloned-ptfs-charts-repo>
 *
 * The extraction is heuristic, not a real chart-format parser: it reads
 * every <tspan> text run in document order and pattern-matches runway
 * pairs (designator immediately followed by its heading), length pairs
 * (feet immediately followed by meters), and frequency pairs (a label
 * immediately followed by a ###.### VHF frequency). Everything else
 * short and label-like (taxiway letters, gate numbers, apron/building
 * names) is kept as a deduplicated "otherLabels" list; multi-word
 * warning/legend prose (e.g. "HOT SPOT" callouts) is filtered out via a
 * stopword-density heuristic. Treat the output as loose grounding
 * context for an LLM, not a validated schema - spot-check it.
 */

const fs = require('fs');
const path = require('path');

const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'be', 'as', 'not', 'and', 'or', 'of', 'is', 'on',
  'in', 'for', 'that', 'ensure', 'pay', 'attention', 'must', 'very',
]);

const RUNWAY_RE = /^\d{1,2}[LCR]?$/;
const HEADING_RE = /^\d{2,3}°$/;
const FEET_RE = /^\d+'$/;
const METERS_RE = /^\d+m$/;
const FREQ_RE = /^1\d{2}\.\d{3}$/;
const HEADER_BOILERPLATE_RE = /^(eff\s|10-9$|apt elev$)/i;

function extractTspans(xml) {
  const re = /<tspan[^>]*>([^<]*)<\/tspan>/g;
  const results = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    const text = decodeXmlEntities(m[1].trim());
    if (text) results.push(text);
  }
  return results;
}

function decodeXmlEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"');
}

function looksLikeProse(token) {
  const words = token.split(/\s+/);
  if (words.length < 3) return false;
  const stopwordHits = words.filter((w) => STOPWORDS.has(w.toLowerCase())).length;
  return stopwordHits >= 2;
}

// "10-9" is Jeppesen-style chart-page boilerplate present on every chart,
// at a consistent offset from the real header fields around it - but not
// at a fixed position in the token stream, since some charts render a
// HOT SPOT warning block (or other content) before the header. Anchoring
// on this literal token is far more robust than assuming a fixed index.
const HEADER_ANCHOR = '10-9';
const HEADER_OFFSETS = {
  effDate: -2,
  location: -1,
  identifiers: 1,
  elevationFt: 2,
  name: 3,
  coordinates: 4,
  aptElevLabel: 5,
  revisionDate: 6,
};

function parseChart(tokens) {
  const anchorIndex = tokens.indexOf(HEADER_ANCHOR);
  const headerIndexes = new Set();
  let identifiers = '';
  let name = null;
  let location = null;
  let elevationFt = null;
  let coordinates = null;

  if (anchorIndex === -1) {
    // Unexpected chart layout - no reliable header to extract from.
    return { icao: null, iata: null, name: null, location: null, elevationFt: null, coordinates: null, runways: [], frequencies: [], otherLabels: [] };
  }

  headerIndexes.add(anchorIndex);
  for (const offset of Object.values(HEADER_OFFSETS)) {
    headerIndexes.add(anchorIndex + offset);
  }
  identifiers = tokens[anchorIndex + HEADER_OFFSETS.identifiers] || '';
  elevationFt = tokens[anchorIndex + HEADER_OFFSETS.elevationFt] || null;
  name = tokens[anchorIndex + HEADER_OFFSETS.name] || null;
  location = tokens[anchorIndex + HEADER_OFFSETS.location] || null;
  coordinates = tokens[anchorIndex + HEADER_OFFSETS.coordinates] || null;

  const [icao, iata] = identifiers.includes('/') ? identifiers.split('/') : [identifiers, null];

  const runways = [];
  const frequencies = [];
  const claimed = new Set(headerIndexes);

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const next = tokens[i + 1];

    if (RUNWAY_RE.test(tok) && next && HEADING_RE.test(next)) {
      let length = null;
      // Runway length pairs (feet then meters) sometimes follow shortly after.
      for (let j = i + 2; j < Math.min(i + 6, tokens.length - 1); j++) {
        if (claimed.has(j) || claimed.has(j + 1)) continue;
        if (FEET_RE.test(tokens[j]) && METERS_RE.test(tokens[j + 1])) {
          length = { feet: tokens[j], meters: tokens[j + 1] };
          claimed.add(j);
          claimed.add(j + 1);
          break;
        }
      }
      runways.push({ designator: tok, heading: next, length });
      claimed.add(i);
      claimed.add(i + 1);
    }

    if (next && FREQ_RE.test(next) && !HEADER_BOILERPLATE_RE.test(tok)) {
      frequencies.push({ facility: tok, frequency: next });
      claimed.add(i);
      claimed.add(i + 1);
    }
  }

  const otherLabels = new Set();
  tokens.forEach((tok, i) => {
    if (claimed.has(i)) return;
    if (HEADER_BOILERPLATE_RE.test(tok)) return;
    if (looksLikeProse(tok)) return;
    if (tok.length > 20) return; // long strings are almost always prose/warnings
    otherLabels.add(tok);
  });

  return {
    icao: (icao || '').trim() || null,
    iata: iata ? iata.trim() : null,
    name,
    location,
    elevationFt,
    coordinates,
    runways,
    frequencies,
    otherLabels: [...otherLabels],
  };
}

function main() {
  const repoPath = process.argv[2];
  if (!repoPath) {
    console.error('Usage: node scripts/extract-charts.js <path-to-cloned-ptfs-charts-repo>');
    process.exit(1);
  }

  const files = findGroundCharts(repoPath);
  console.log(`Found ${files.length} ground chart(s).`);

  const outDir = path.join(__dirname, '..', 'data', 'charts');
  fs.mkdirSync(outDir, { recursive: true });

  let written = 0;
  for (const file of files) {
    const xml = fs.readFileSync(file, 'utf8');
    const tokens = extractTspans(xml);
    const chart = parseChart(tokens);
    if (!chart.icao) {
      console.warn(`Skipping (no ICAO found): ${file}`);
      continue;
    }
    chart.sourceFile = path.relative(repoPath, file);
    const outPath = path.join(outDir, `${chart.icao}.json`);
    fs.writeFileSync(outPath, JSON.stringify(chart, null, 2) + '\n');
    written++;
  }

  console.log(`Wrote ${written} chart file(s) to ${outDir}`);
}

function findGroundCharts(root) {
  const results = [];
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...findGroundCharts(full));
    } else if (/ground chart\.svg$/i.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

main();
