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

// Runway designators are compared without a leading zero (02 = 2) and in capitals.
const normRunway = (r) => String(r || '').trim().toUpperCase().replace(/^0+(?=\d)/, '');
const splitKey = (key) => key.split(',').map(normRunway);

function runwaysOf(map) {
  return [...new Set(Object.keys(map || {}).flatMap(splitKey))].sort();
}

function legsFor(map, runway) {
  const want = normRunway(runway);
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
  const initial = Object.entries(sid.initial || {}).find(([k]) => splitKey(k).includes(normRunway(runway)));
  return { name: sid.name, runway: normRunway(runway), ...resolveLegs(legs), initial: initial ? initial[1] : null };
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
  return { name: star.name, runway: normRunway(runway), entry: first || null, ...resolved };
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

// ---- automatic selection ----------------------------------------------------
// Picks a runway, SID / STAR and approach from the airports alone, the way a
// dispatcher would without wind: the runway that points most nearly along the
// direction of flight, the departure that exits towards the destination, and
// the arrival that adds the least distance.

const { distanceBearing, angleDiff } = require('./geo');

const approachRank = { ILS: 0, LDA: 1, VOR: 2, GLS: 3, RNP: 4 }; // RNP AR needs authorization, GLS needs ground equipment
const parallelRank = (rwy) => ({ C: 0, R: 1, L: 2 }[String(rwy).slice(-1)] ?? 0);
const lastPlaced = (list, from) => (list.length ? list[list.length - 1] : from);

function polylineNm(points) {
  let nm = 0;
  for (let i = 1; i < points.length; i++) nm += distanceBearing(points[i - 1], points[i]).distanceNm;
  return nm;
}

function runwayHeadings(airport) {
  const out = new Map();
  for (const r of airport?.runways || []) if (r.headingDeg != null) out.set(normRunway(r.id), r.headingDeg);
  return out;
}

/** Departure runway and SID for flying from `from` to `to`; {} when there are no procedures. */
function chooseDeparture(from, to) {
  const data = files.get(from.icao);
  if (!data || !data.sids.length) return {};
  const track = distanceBearing(from, to).bearingDeg;
  const headings = runwayHeadings(from);
  const candidates = [];
  for (const sid of data.sids) {
    for (const key of Object.keys(sid.runways)) {
      for (const rwy of splitKey(key)) {
        const heading = headings.get(rwy);
        if (heading == null) continue;
        const resolved = resolveLegs(sid.runways[key]);
        const exit = lastPlaced(resolved.fixes, from);
        // distance flown via the SID's last fix, plus penalties: fixes with no position, and SIDs that are only radar vectors
        const via = distanceBearing(from, exit).distanceNm + distanceBearing(exit, to).distanceNm;
        const score = Math.abs(angleDiff(heading, track)) * 0.4 + (via - distanceBearing(from, to).distanceNm) + resolved.unplaced.length * 6 + (resolved.fixes.length ? 0 : 5) + parallelRank(rwy) * 0.01;
        // a SID that ends at the airport itself (or is only vectors) is not a route to anywhere, so it is never picked automatically
        if (!resolved.fixes.length || distanceBearing(from, exit).distanceNm < 2.5) continue;
        candidates.push({ sid: sid.name, depRunway: rwy, score });
      }
    }
  }
  candidates.sort((a, b) => a.score - b.score);
  // nothing sensible (every departure goes the wrong way): fly direct rather than a long detour
  return candidates[0] && candidates[0].score < 25 ? { sid: candidates[0].sid, depRunway: candidates[0].depRunway } : {};
}

/** Arrival runway, STAR, entry and approach; {} when there are no procedures. */
function chooseArrival(from, to) {
  const data = files.get(to.icao);
  if (!data || (!data.stars.length && !data.approaches.length)) return {};
  const track = distanceBearing(from, to).bearingDeg;
  const headings = runwayHeadings(to);
  const direct = distanceBearing(from, to).distanceNm;
  const best = [];
  const runways = new Set([...data.stars.flatMap((p) => Object.keys(p.runways).flatMap(splitKey)), ...data.approaches.flatMap((a) => splitKey(a.runway))]);
  for (const rwy of runways) {
    const heading = headings.get(rwy);
    if (heading == null) continue;
    // an approach: the best kind that this runway has, placed fixes preferred
    const apps = data.approaches.filter((a) => splitKey(a.runway).includes(rwy)).map((a) => ({ a, resolved: resolveLegs(a.legs), rank: (approachRank[a.type] ?? 5) }));
    apps.sort((x, y) => (x.rank + x.resolved.unplaced.length * 0.5) - (y.rank + y.resolved.unplaced.length * 0.5));
    const app = apps[0];
    for (const star of data.stars) {
      const legs = legsFor(star.runways, rwy);
      if (!legs) continue;
      const resolved = resolveLegs(legs);
      const entries = (star.entries || []).map(lookup).filter(Boolean);
      const entry = entries.sort((a, b) => distanceBearing(from, a).distanceNm - distanceBearing(from, b).distanceNm)[0];
      if (!entry && !resolved.fixes.length) continue;
      const path = [from, ...(entry ? [entry] : []), ...resolved.fixes];
      const end = path[path.length - 1];
      let iaf = null;
      if (app) {
        const placed = (app.a.iaf || []).map(lookup).filter(Boolean);
        iaf = placed.sort((a, b) => distanceBearing(end, a).distanceNm - distanceBearing(end, b).distanceNm)[0] || null;
        if (iaf) path.push(iaf);
      }
      const total = polylineNm(path) + distanceBearing(path[path.length - 1], to).distanceNm;
      const score = (total - direct) + resolved.unplaced.length * 6 + (/only if unable|use only if/i.test(star.notes || '') ? 15 : 0)
        + Math.abs(angleDiff(heading, track)) * 0.1 + (app ? app.rank * 2 + app.resolved.unplaced.length : 12) + parallelRank(rwy) * 0.01;
      best.push({ score, star: star.name, arrRunway: rwy, starEntry: entry && entry.ident, approach: app && app.a.name, approachIaf: iaf && iaf.ident });
    }
  }
  best.sort((a, b) => a.score - b.score);
  const pick = best[0];
  if (!pick) return {};
  const out = { star: pick.star, arrRunway: pick.arrRunway };
  if (pick.starEntry && (data.stars.find((s) => s.name === pick.star).entries || []).includes(pick.starEntry)) out.starEntry = pick.starEntry;
  if (pick.approach) { out.approach = pick.approach; if (pick.approachIaf) out.approachIaf = pick.approachIaf; }
  return out;
}

module.exports = { chooseDeparture, chooseArrival, listProcedures, expandSid, expandStar, expandApproach, hasProcedures: (icao) => files.has(String(icao || '').toUpperCase()), findAirport };
