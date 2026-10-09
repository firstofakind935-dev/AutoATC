// SIDs, STARs and approaches (planner/data/procedures/<ICAO>.json, read from the
// AeroNav charts) resolved against the navdata. A procedure is a list of fix
// names; here each name is looked up for its position. Names that have no
// position (the chart uses a fix 24SPY doesn't have) are returned as
// `unplaced` and left out of the route rather than guessed at.

const fs = require('fs');
const path = require('path');
const { findFix, findAirport } = require('./navdata');
const { project } = require('./geo');

const DIR = path.join(__dirname, '..', 'data', 'procedures');

const files = new Map();
for (const file of fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith('.json')) : []) {
  const data = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
  files.set(data.icao, data);
}

// Fixes defined by geometry on a chart (a DME fix on a radial) rather than
// listed by 24SPY: placed from a VOR/fix we do have.
const derived = new Map();
for (const data of files.values()) {
  for (const d of data.derivedFixes || []) {
    const from = findFix(d.from);
    if (from) derived.set(d.ident, { ident: d.ident, type: 'WPT', ...project(from, d.radialDeg, d.distNm) });
  }
}
const lookup = (ident) => findFix(ident) || derived.get(ident) || null;

const splitKey = (key) => key.split(',').map((s) => s.trim().toUpperCase());

function runwaysOf(map) {
  return [...new Set(Object.keys(map || {}).flatMap(splitKey))].sort();
}

function legsFor(map, runway) {
  const want = String(runway || '').toUpperCase();
  for (const [key, legs] of Object.entries(map || {})) if (splitKey(key).includes(want)) return legs;
  return null;
}

function resolveLegs(legs) {
  const fixes = [];
  const unplaced = [];
  let vectors = false;
  for (const leg of legs) {
    if (leg === 'vectors') { vectors = true; continue; }
    const fix = lookup(leg.fix);
    if (!fix) { unplaced.push(leg.fix); continue; }
    const constraint = leg.min != null ? { altMinFt: leg.min } : leg.max != null ? { altMaxFt: leg.max } : leg.at != null ? { altAtFt: leg.at } : {};
    fixes.push({ ident: fix.ident, type: fix.type, lat: fix.lat, lon: fix.lon, ...constraint });
  }
  return { fixes, unplaced, vectors };
}

const procedureError = (message) => Object.assign(new Error(message), { status: 400 });

const find = (list, name) => (list || []).find((p) => p.name === String(name || '').toUpperCase());

/** Summary for the planner UI: names, which runways, how complete. */
function listProcedures(icao) {
  const data = files.get(String(icao || '').toUpperCase());
  if (!data) return { icao: String(icao || '').toUpperCase(), sids: [], stars: [], approaches: [] };
  const sum = (kind, p) => {
    const all = (p.runways ? Object.values(p.runways).flat() : [...(p.iaf || []).map((fix) => ({ fix })), ...(p.legs || [])]).filter((l) => l !== 'vectors');
    const names = [...new Set(all.map((l) => l.fix))];
    return { name: p.name, title: p.title || p.name, chart: p.chart, runways: p.runways ? runwaysOf(p.runways) : splitKey(p.runway), entries: p.entries, iaf: p.iaf, unplaced: names.filter((n) => !lookup(n)), notes: p.notes };
  };
  return { icao: data.icao, sids: data.sids.map((p) => sum('sid', p)), stars: data.stars.map((p) => sum('star', p)), approaches: data.approaches.map((p) => ({ ...sum('approach', p), type: p.type, finalCourseDeg: p.finalCourseDeg })) };
}

/** Departure fixes for runway `runway`. */
function expandSid(icao, name, runway) {
  const data = files.get(String(icao || '').toUpperCase());
  const sid = data && find(data.sids, name);
  if (!sid) throw procedureError(`No SID "${name}" for ${icao}`);
  const legs = legsFor(sid.runways, runway);
  if (!legs) throw procedureError(`SID ${sid.name} is not published for runway ${runway || '(none given)'} - it has ${runwaysOf(sid.runways).join(', ')}`);
  const initial = Object.entries(sid.initial || {}).find(([k]) => splitKey(k).includes(String(runway).toUpperCase()));
  return { name: sid.name, runway: String(runway).toUpperCase(), ...resolveLegs(legs), initial: initial ? initial[1] : null };
}

/** Arrival fixes for runway `runway`, joined from `entry` (one of the chart's entry fixes) if given. */
function expandStar(icao, name, runway, entry) {
  const data = files.get(String(icao || '').toUpperCase());
  const star = data && find(data.stars, name);
  if (!star) throw procedureError(`No STAR "${name}" for ${icao}`);
  const legs = legsFor(star.runways, runway);
  if (!legs) throw procedureError(`STAR ${star.name} is not published for runway ${runway || '(none given)'} - it has ${runwaysOf(star.runways).join(', ')}`);
  const resolved = resolveLegs(legs);
  const wanted = entry ? String(entry).toUpperCase() : null;
  if (wanted && !(star.entries || []).includes(wanted)) throw procedureError(`STAR ${star.name} is entered from ${(star.entries || []).join(', ')}, not ${wanted}`);
  const first = wanted || (star.entries || [])[0];
  const entryFix = first && !resolved.fixes.some((f) => f.ident === first) ? lookup(first) : null;
  if (entryFix) resolved.fixes.unshift({ ident: entryFix.ident, type: entryFix.type, lat: entryFix.lat, lon: entryFix.lon });
  else if (first && !resolved.fixes.some((f) => f.ident === first) && !resolved.unplaced.includes(first)) resolved.unplaced.unshift(first);
  return { name: star.name, runway: String(runway).toUpperCase(), entry: first || null, ...resolved };
}

/** Approach fixes: the chosen initial approach fix, then the final fixes. */
function expandApproach(icao, name, iaf) {
  const data = files.get(String(icao || '').toUpperCase());
  const app = data && (data.approaches || []).find((a) => a.name === String(name || '').toUpperCase() || a.chart === name);
  if (!app) throw procedureError(`No approach "${name}" for ${icao}`);
  const start = iaf ? String(iaf).toUpperCase() : null;
  if (start && !(app.iaf || []).includes(start)) throw procedureError(`${app.name} starts from ${(app.iaf || []).join(', ')}, not ${start}`);
  const resolved = resolveLegs(start ? [{ fix: start }, ...app.legs] : app.legs);
  return { name: app.name, runway: app.runway, type: app.type, finalCourseDeg: app.finalCourseDeg, missed: app.missed, ...resolved };
}

module.exports = { listProcedures, expandSid, expandStar, expandApproach, hasProcedures: (icao) => files.has(String(icao || '').toUpperCase()), findAirport };
