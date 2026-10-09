// Builds a complete flight plan: route, vertical profile, nav log, times
// and fuel - what SimBrief calls an OFP. The companion app's FMS imports
// the result (see companion/lib/fms.js), so `waypoints` and `profile` are
// the contract the autopilot flies; `navlog`, `times` and `fuel` are the
// briefing for the pilot.

const { distanceBearing, project } = require('./geo');
const { findAirport } = require('./navdata');
const { findAircraft } = require('./aircraft');
const { findRoute, parseRoute } = require('./route');
const { expandSid, expandStar, expandApproach } = require('./procedures');

const MIN_CRUISE_AGL_FT = 1500;
const CRUISE_SEARCH_STEP_FT = 500;
// Fraction of the trip the climb + descent may use when picking a cruise
// altitude automatically - leaves some level cruise even on short hops.
const MAX_CLIMB_DESCENT_SHARE = 0.85;
const CONTINGENCY_SHARE = 0.05;
const FINAL_RESERVE_MIN = 30;

// Rounds to a multiple of `step`, without float noise (0.1 steps come out
// as 5.6, not 5.6000000000000005).
const round = (n, step = 1) => {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  return Number((Math.round(n / step) * step).toFixed(decimals));
};

function planError(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// Semicircular rule: eastbound (track 000-179) odd thousands, westbound
// even - the convention real cruise levels follow below FL410.
function semicircularCap(altFt, trackDeg) {
  const eastbound = trackDeg < 180;
  let thousands = Math.floor(altFt / 1000);
  if ((thousands % 2 === 1) !== eastbound) thousands -= 1;
  return thousands * 1000;
}

function buildPlan({ callsign, aircraftType, origin, destination, cruiseAltFt, route, sid, depRunway, star, arrRunway, starEntry, approach, approachIaf }) {
  const flightCallsign = String(callsign || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!flightCallsign) throw planError('Callsign is required');
  const aircraft = findAircraft(aircraftType);
  if (!aircraft) throw planError(`Unknown aircraft type "${aircraftType}"`);
  const from = findAirport(origin);
  const to = findAirport(destination);
  if (!from) throw planError(`Unknown departure airport "${origin}"`);
  if (!to) throw planError(`Unknown arrival airport "${destination}"`);
  if (from.icao === to.icao) throw planError('Departure and arrival must be different airports');

  // Departure and arrival procedures (SID / STAR / approach) from the charts. The
  // en-route part runs from the end of the SID to the start of the STAR; fixes a
  // chart uses that we have no position for are reported, not guessed.
  const procedures = {};
  let sidFixes = [];
  let arrivalFixes = [];
  if (sid) {
    if (!depRunway) throw planError('Pick the departure runway for the SID');
    procedures.sid = expandSid(from.icao, sid, depRunway);
    sidFixes = procedures.sid.fixes;
  }
  if (star) {
    if (!arrRunway) throw planError('Pick the arrival runway for the STAR');
    procedures.star = expandStar(to.icao, star, arrRunway, starEntry);
    arrivalFixes = procedures.star.fixes;
  }
  if (approach) {
    procedures.approach = expandApproach(to.icao, approach, approachIaf);
    // an approach follows the STAR; its first fix is where the pilot joins it
    arrivalFixes = [...arrivalFixes, ...procedures.approach.fixes];
  }
  const anyProcedure = Boolean(sid || star || approach);

  const routeStart = sidFixes.length ? sidFixes[sidFixes.length - 1] : from;
  const routeEnd = arrivalFixes.length ? arrivalFixes[0] : to;
  const enrouteFixes = route && String(route).trim() ? parseRoute(route) : anyProcedure && distanceBearing(routeStart, routeEnd).distanceNm < 2 ? [] : findRoute(routeStart, routeEnd);
  // Join the pieces; a fix that repeats (the SID's last fix is also the first en-route one) appears once.
  const routeFixes = [];
  for (const f of [...sidFixes, ...enrouteFixes, ...arrivalFixes]) {
    const prev = routeFixes[routeFixes.length - 1];
    if (prev && prev.ident === f.ident) { Object.assign(prev, f); continue; }
    routeFixes.push({ ...f });
  }
  const points = [from, ...routeFixes, to].map((p) => {
    const point = { ident: p.ident, type: p.type, lat: p.lat, lon: p.lon };
    for (const k of ['altMinFt', 'altMaxFt', 'altAtFt']) if (p[k] != null) point[k] = p[k];
    return point;
  });

  let cumNm = 0;
  const waypoints = points.map((p, i) => {
    if (i === 0) return { ...p, legNm: 0, trackDeg: null, cumNm: 0 };
    const { distanceNm, bearingDeg } = distanceBearing(points[i - 1], p);
    cumNm += distanceNm;
    return { ...p, legNm: round(distanceNm, 0.1), trackDeg: round(bearingDeg), cumNm: round(cumNm, 0.1) };
  });
  const totalNm = cumNm;

  const descentKt = (aircraft.cruiseKt + aircraft.approachKt) / 2;
  const climbNm = (alt) => (Math.max(0, alt - from.elevationFt) / aircraft.climbFpm / 60) * aircraft.climbKt;
  const descentNm = (alt) => (Math.max(0, alt - to.elevationFt) / aircraft.descentFpm / 60) * descentKt;
  const floorFt = Math.max(from.elevationFt, to.elevationFt) + MIN_CRUISE_AGL_FT;
  const warnings = [];

  let cruise;
  if (cruiseAltFt) {
    cruise = Number(cruiseAltFt);
    if (!Number.isFinite(cruise) || cruise < floorFt) throw planError(`Cruise altitude must be at least ${floorFt} ft`);
    if (cruise > aircraft.ceilingFt) throw planError(`${aircraft.name} ceiling is ${aircraft.ceilingFt} ft`);
  } else {
    cruise = aircraft.ceilingFt;
    while (cruise > floorFt && climbNm(cruise) + descentNm(cruise) > totalNm * MAX_CLIMB_DESCENT_SHARE) {
      cruise -= CRUISE_SEARCH_STEP_FT;
    }
    const directTrack = distanceBearing(from, to).bearingDeg;
    cruise = Math.max(round(floorFt, 500), cruise >= 2000 ? semicircularCap(cruise, directTrack) : cruise);
  }

  // Top of climb / top of descent. If the trip is too short to reach the
  // chosen cruise, climb and descent meet where they would cross.
  let tocNm = climbNm(cruise);
  let todNm = totalNm - descentNm(cruise);
  let peakAltFt = cruise;
  if (tocNm > todNm) {
    const share = climbNm(cruise) / (climbNm(cruise) + descentNm(cruise));
    tocNm = totalNm * share;
    todNm = tocNm;
    peakAltFt = round(from.elevationFt + (tocNm / aircraft.climbKt) * 60 * aircraft.climbFpm, 100);
    warnings.push(`Too short to reach ${cruise} ft - the profile peaks at about ${peakAltFt} ft.`);
  }

  const altitudeAt = (d) => {
    if (d <= tocNm) return tocNm ? from.elevationFt + ((peakAltFt - from.elevationFt) * d) / tocNm : peakAltFt;
    if (d >= todNm) return totalNm > todNm ? to.elevationFt + ((peakAltFt - to.elevationFt) * (totalNm - d)) / (totalNm - todNm) : peakAltFt;
    return peakAltFt;
  };
  // Hours from departure to distance d along the route.
  const hoursAt = (d) => {
    const climb = Math.min(d, tocNm) / aircraft.climbKt;
    const level = Math.max(0, Math.min(d, todNm) - tocNm) / aircraft.cruiseKt;
    const descent = Math.max(0, d - todNm) / descentKt;
    return climb + level + descent;
  };
  const burnAt = (d) => {
    const climb = Math.min(d, tocNm) / aircraft.climbKt;
    const level = Math.max(0, Math.min(d, todNm) - tocNm) / aircraft.cruiseKt;
    const descent = Math.max(0, d - todNm) / descentKt;
    return aircraft.burnKgHr * (1.3 * climb + level + 0.4 * descent);
  };

  const tripKg = round(burnAt(totalNm), 10);
  const fuel = {
    unit: 'KG',
    taxi: aircraft.taxiKg,
    trip: tripKg,
    contingency: round(tripKg * CONTINGENCY_SHARE, 10),
    finalReserve: round((aircraft.burnKgHr * 0.8 * FINAL_RESERVE_MIN) / 60, 10),
  };
  fuel.block = fuel.taxi + fuel.trip + fuel.contingency + fuel.finalReserve;
  const takeoffFuel = fuel.block - fuel.taxi;

  // Nav log: every waypoint plus T/C and T/D pseudo-waypoints, SimBrief style.
  const pseudo = [];
  if (tocNm > 0.5 && tocNm < totalNm - 0.5) pseudo.push({ ident: 'T/C', d: tocNm });
  if (todNm > tocNm + 0.5 && todNm < totalNm - 0.5) pseudo.push({ ident: 'T/D', d: todNm });
  const entries = waypoints.map((w) => ({ ident: w.ident, type: w.type, lat: w.lat, lon: w.lon, d: w.cumNm, trackDeg: w.trackDeg }));
  for (const p of pseudo) {
    const legIndex = waypoints.findIndex((w) => w.cumNm >= p.d);
    const prev = waypoints[legIndex - 1];
    const along = p.d - prev.cumNm;
    const pos = project(prev, waypoints[legIndex].trackDeg, along);
    entries.push({ ident: p.ident, type: 'PSEUDO', lat: pos.lat, lon: pos.lon, d: p.d, trackDeg: waypoints[legIndex].trackDeg });
  }
  entries.sort((a, b) => a.d - b.d);
  const navlog = entries.map((e, i) => ({
    ident: e.ident,
    type: e.type,
    trackDeg: e.trackDeg,
    legNm: i === 0 ? 0 : round(e.d - entries[i - 1].d, 0.1),
    cumNm: round(e.d, 0.1),
    altFt: round(altitudeAt(e.d), 100),
    eteMin: round(hoursAt(e.d) * 60, 0.1),
    fuelRemKg: round(takeoffFuel - burnAt(e.d), 10),
  }));

  const routeText = anyProcedure
    ? [
        procedures.sid && `SID ${procedures.sid.name}/${procedures.sid.runway}`,
        enrouteFixes.length ? `DCT ${enrouteFixes.map((f) => f.ident).join(' DCT ')} DCT` : 'DCT',
        procedures.star && `STAR ${procedures.star.name}/${procedures.star.runway}`,
        procedures.approach && `APP ${procedures.approach.name}`,
      ].filter(Boolean).join(' ')
    : routeFixes.length ? `DCT ${routeFixes.map((f) => f.ident).join(' DCT ')} DCT` : 'DCT';
  for (const [kind, proc] of Object.entries(procedures)) {
    if (proc.unplaced.length) warnings.push(`${kind.toUpperCase()} ${proc.name}: no position for ${proc.unplaced.join(', ')} - skipped, so that part is flown direct.`);
    if (proc.vectors) warnings.push(`${kind.toUpperCase()} ${proc.name} ends with radar vectors - expect ATC to direct you after its last fix.`);
  }

  return {
    callsign: flightCallsign,
    aircraft: { icao: aircraft.icao, name: aircraft.name, fms: aircraft.fms, category: aircraft.category },
    origin: { icao: from.icao, name: from.name, lat: from.lat, lon: from.lon, elevationFt: from.elevationFt, runways: from.runways },
    destination: { icao: to.icao, name: to.name, lat: to.lat, lon: to.lon, elevationFt: to.elevationFt, runways: to.runways },
    route: routeText,
    procedures: anyProcedure ? Object.fromEntries(Object.entries(procedures).map(([k, v]) => [k, { name: v.name, runway: v.runway, unplaced: v.unplaced, vectors: v.vectors, initial: v.initial || null, missed: v.missed || null }])) : undefined,
    distanceNm: round(totalNm, 0.1),
    waypoints,
    profile: {
      cruiseAltFt: cruise,
      peakAltFt,
      tocNm: round(tocNm, 0.1),
      todNm: round(todNm, 0.1),
      climbKt: aircraft.climbKt,
      cruiseKt: aircraft.cruiseKt,
      descentKt: round(descentKt),
      approachKt: aircraft.approachKt,
      climbFpm: aircraft.climbFpm,
      descentFpm: aircraft.descentFpm,
      originElevFt: from.elevationFt,
      destElevFt: to.elevationFt,
    },
    navlog,
    times: {
      climbMin: round((tocNm / aircraft.climbKt) * 60, 0.1),
      enrouteMin: round(hoursAt(totalNm) * 60, 0.1),
    },
    fuel,
    warnings,
  };
}

module.exports = { buildPlan, semicircularCap };
