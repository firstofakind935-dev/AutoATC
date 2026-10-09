// FMS / autopilot window.
//
// One MCDU engine (screen, line select keys, scratchpad, pages) dressed as
// four manufacturers' units - Airbus MCDU, Boeing CDU, Bombardier (Collins)
// FMS and Embraer (Honeywell) MCDU - each with its own page names, key
// layout and route-activation habit (Airbus inserts straight away, the
// others need EXEC). Above it, that manufacturer's autopilot panel: Airbus
// FCU, Boeing MCP, or the Bombardier/Embraer guidance panel.
//
// Flight logic lives in ../lib/fms.js (Fms) and ../lib/autopilot.js
// (Autopilot); this file is the cockpit around them. Every tracking update
// from the control window runs one guidance + autopilot step, and the
// resulting key presses go to the game (LIVE) or just to the log (DRY RUN).

/* global Fms, Autopilot */

const api = window.companion;
const $ = (id) => document.getElementById(id);

const COLS = 24;
const PLAN_ID_RE = /^[A-HJ-NP-Z2-9]{6}$/;

// PTFS: throttle on W/S, pitch and bank by mouse (see ../lib/mouseSteer.js).
// The roll/pitch keys only apply with "Pitch & bank control: Keys", for
// other games or keyboard-flying setups.
const DEFAULT_KEYMAP = {
  rollLeft: 'ArrowLeft',
  rollRight: 'ArrowRight',
  pitchUp: 'ArrowDown',
  pitchDown: 'ArrowUp',
  throttleUp: 'W',
  throttleDown: 'S',
};
const KEYMAP_LABELS = {
  rollLeft: 'Roll left',
  rollRight: 'Roll right',
  pitchUp: 'Pitch up (nose up)',
  pitchDown: 'Pitch down (nose down)',
  throttleUp: 'Throttle up',
  throttleDown: 'Throttle down',
};

// Aircraft names as the HUD shows them -> FMS style. Anything else falls
// back to the plan's own style, then Boeing.
const HUD_TYPE_SKINS = [
  [/airbus a220/i, 'bombardier'],
  [/airbus|atr|eurofighter/i, 'airbus'],
  [/bombardier|crj|q400|learjet/i, 'bombardier'],
  [/e190|embraer/i, 'embraer'],
];

// ---------------------------------------------------------------- state

const settings = {
  plannerUrl: '',
  skin: 'auto',
  keymap: { ...DEFAULT_KEYMAP },
  steering: 'mouse', // mouse | keys - how pitch and bank are flown
  mouseCenter: null, // {x, y} screen point where the aircraft flies straight and level
  mouseDeflectionPx: 120, // how far off center a nudge moves the cursor
  invertPitch: false,
  // Phone/tablet control: off | lan (this Wi-Fi, lib/remoteServer.js) |
  // relay (anywhere, through the flight planner - lib/relayClient.js).
  remoteMode: 'off',
  remotePort: 8765,
  remoteCode: null, // 6 digits, for lan
  relayCode: null, // 12 characters, for relay
  relaySecret: null,
  live: false,
};
const ap = Autopilot.create();
const ui = {
  page: 'init',
  scratch: '',
  message: null, // shown in the scratchpad until cleared
  scroll: 0,
  fms: null, // active Fms state
  plan: null, // active plan
  pending: null, // { describe, apply } - a route/direct-to awaiting EXEC or INSERT
  navdata: null,
  telemetry: null,
  guidance: null,
  lastInputs: [],
  coRoute: '',
};

// ---------------------------------------------------------------- helpers

const pad3 = (n) => String(Math.round(n)).padStart(3, '0');
const fmtAlt = (ft) => (ft == null ? '-----' : ft >= 18000 ? `FL${pad3(ft / 100)}` : String(Math.round(ft)));
const fmtNm = (nm) => (nm == null ? '--' : nm < 10 ? nm.toFixed(1) : String(Math.round(nm)));
function fmtTime(min) {
  if (min == null || !Number.isFinite(min)) return '--:--';
  const s = Math.round(min * 60);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// A cell is [text, colourClass]; a side is a list of cells.
const c = (text, cls = '') => [String(text ?? ''), cls];

function currentSkinId() {
  if (settings.skin !== 'auto') return settings.skin;
  const hudType = ui.telemetry?.aircraftType || '';
  for (const [re, skin] of HUD_TYPE_SKINS) if (re.test(hudType)) return skin;
  return ui.plan?.aircraft?.fms || 'boeing';
}
const skin = () => SKINS[currentSkinId()];

function flash(message) {
  ui.message = message;
  render();
}

// Parses what pilots type for an altitude: FL050, 050 (flight level), 5000.
function parseAltitude(text) {
  const t = text.trim().toUpperCase();
  const fl = t.match(/^FL?(\d{2,3})$/);
  if (fl) return Number(fl[1]) * 100;
  if (/^\d{3}$/.test(t)) return Number(t) * 100;
  if (/^\d{4,5}$/.test(t)) return Number(t);
  return null;
}

// ---------------------------------------------------------------- plans

async function fetchPlan(idOrCallsign) {
  const base = settings.plannerUrl.replace(/\/$/, '');
  if (!base) throw new Error('SET PLANNER URL');
  const key = idOrCallsign.trim().toUpperCase();
  const urls = PLAN_ID_RE.test(key)
    ? [`${base}/api/plans/${key}`, `${base}/api/plans?callsign=${encodeURIComponent(key)}`]
    : [`${base}/api/plans?callsign=${encodeURIComponent(key)}`];
  for (const url of urls) {
    const res = await fetch(url).catch(() => null);
    if (!res) throw new Error('PLANNER NOT REACHABLE');
    if (res.ok) return res.json();
  }
  throw new Error('NOT IN DATA BASE');
}

async function loadNavdata() {
  if (ui.navdata || !settings.plannerUrl) return;
  try {
    const res = await fetch(`${settings.plannerUrl.replace(/\/$/, '')}/api/navdata`);
    if (res.ok) ui.navdata = await res.json();
  } catch {
    // DIR TO a fix outside the plan just won't find it.
  }
}

function activatePlan(plan) {
  ui.plan = plan;
  ui.fms = Fms.load(plan);
  ui.scroll = 0;
  // Sensible panel defaults for the new flight.
  ap.selected.altFt = plan.profile.cruiseAltFt;
  loadNavdata();
}

// Route import, shared by every skin's INIT/RTE/FPL page.
async function importRoute() {
  const key = ui.scratch.trim();
  if (!key) return flash('ENTER PLAN ID OR CALLSIGN');
  ui.scratch = '';
  flash('LOADING...');
  try {
    const plan = await fetchPlan(key);
    ui.coRoute = plan.id;
    ui.message = null;
    if (skin().execRequired) {
      ui.pending = { describe: `${plan.origin.icao}-${plan.destination.icao}`, apply: () => activatePlan(plan), kind: 'route', plan };
    } else {
      activatePlan(plan);
    }
  } catch (err) {
    ui.message = err.message;
  }
  render();
}

function requestDirectTo(ident) {
  if (!ui.fms) return flash('NO ACTIVE ROUTE');
  if (!ui.telemetry) return flash('NO POSITION');
  const wanted = ident.trim().toUpperCase();
  const known = ui.fms.waypoints.some((w) => w.ident === wanted)
    || ui.navdata?.fixes?.some((f) => f.ident === wanted)
    || ui.navdata?.airports?.some((a) => a.icao === wanted);
  if (!known) return flash('NOT IN DATA BASE');
  ui.scratch = '';
  ui.pending = {
    kind: 'dir',
    describe: `DIR ${wanted}`,
    ident: wanted,
    apply: () => {
      Fms.directTo(ui.fms, wanted, { lat: ui.telemetry.lat, lon: ui.telemetry.lon }, ui.navdata);
      if (ap.engaged) setLateral('LNAV');
    },
  };
  render();
}

function execPending() {
  if (!ui.pending) return;
  try {
    ui.pending.apply();
  } catch (err) {
    ui.message = err.message;
  }
  ui.pending = null;
  render();
}

function erasePending() {
  ui.pending = null;
  render();
}

function setCruise(text) {
  const alt = parseAltitude(text);
  if (alt == null || alt < 500 || alt > 60000) return flash('FORMAT ERROR');
  ui.scratch = '';
  if (ui.fms) ui.fms.cruiseAltFt = alt;
  ap.selected.altFt = alt;
  render();
}

// ---------------------------------------------------------------- pages
//
// A page is a function returning { title, titleRight, rows, lsk }. rows is
// six {label: [left cells, right cells], data: [left cells, right cells]};
// lsk maps 'L1'..'R6' to handlers called with the scratchpad contents.

const blankRow = () => ({ label: [[], []], data: [[], []] });
function rows(list) {
  const out = list.slice(0, 6);
  while (out.length < 6) out.push(blankRow());
  return out;
}
const row = (labelL, dataL, labelR = [], dataR = []) => ({ label: [labelL, labelR], data: [dataL, dataR] });

// Route waypoints as pilots write them: "BUCFA OCEEN" (no DCTs).
const viaText = (p) => p.route.replace(/\bDCT\b/g, ' ').trim().replace(/\s+/g, ' ') || 'DIRECT';

function routePage(s) {
  if (s === SKINS.airbus) return airbusInitPage(s);
  const p = ui.pending?.kind === 'route' ? ui.pending.plan : ui.plan;
  const box = (n) => c('□'.repeat(n), 'amber');
  const pendingRoute = ui.pending?.kind === 'route';
  return {
    title: pendingRoute ? `MOD ${s.titles.rte}` : ui.plan ? `ACT ${s.titles.rte}` : s.titles.rte,
    rows: rows([
      row([c('ORIGIN', 'label')], [p ? c(p.origin.icao, 'big') : box(4)], [c('DEST', 'label')], [p ? c(p.destination.icao, 'big') : box(4)]),
      row([c(s.labels.coRoute, 'label')], [ui.coRoute ? c(ui.coRoute, 'big') : c('------', 'dim')], [c('FLT NO', 'label')], [p ? c(p.callsign, 'big') : c('--------', 'dim')]),
      row([c('VIA', 'label')], [p ? c(viaText(p).slice(0, 22), 'green') : c('', '')]),
      row([c('AIRCRAFT', 'label')], [p ? c(p.aircraft.icao, 'big') : c('----', 'dim')], [c('DIST', 'label')], [p ? c(`${p.distanceNm}NM`, 'big') : c('', '')]),
      row([c('CRZ ALT', 'label')], [p ? c(fmtAlt(ui.fms?.cruiseAltFt ?? p.profile.cruiseAltFt), 'big') : box(5)], [c('BLOCK FUEL', 'label')], [p ? c(`${p.fuel.block}KG`, 'big') : c('', '')]),
      pendingRoute
        ? row([], [c(s.eraseLabel, 'white')], [], [c('ACTIVATE>', 'amber')])
        : row([], [c(ui.plan ? '<LEGS' : '', 'white')], [], [c(ui.plan ? 'PROG>' : '', 'white')]),
    ]),
    lsk: {
      L2: importRoute,
      L5: (sp) => setCruise(sp),
      L6: () => (pendingRoute ? erasePending() : goPage('legs')),
      R6: () => (pendingRoute ? flash('PRESS EXEC') : goPage('prog')),
    },
  };
}

// Airbus INIT A: CO RTE on 1L, FROM/TO on 1R, CRZ FL on 6L.
function airbusInitPage() {
  const p = ui.plan;
  const box = (n) => c('□'.repeat(n), 'amber');
  return {
    title: 'INIT',
    rows: rows([
      row([c('CO RTE', 'label')], [ui.coRoute ? c(ui.coRoute, 'big cyan') : box(10)], [c('FROM/TO', 'label')], [p ? c(`${p.origin.icao}/${p.destination.icao}`, 'big cyan') : box(9)]),
      row([c('ALTN/CO RTE', 'label')], [c('----/---------', 'dim')], [c('', '')], [c('', '')]),
      row([c('FLT NBR', 'label')], [p ? c(p.callsign, 'big cyan') : box(8)], [c('', '')], [c('', '')]),
      row([c('ROUTE', 'label')], [p ? c(viaText(p).slice(0, 22), 'green') : c('', '')]),
      row([c('COST INDEX', 'label')], [c('---', 'dim')], [c('BLOCK FUEL', 'label')], [p ? c(`${(p.fuel.block / 1000).toFixed(1)}T`, 'big green') : c('---', 'dim')]),
      row([c('CRZ FL/TEMP', 'label')], [p ? c(`${fmtAlt(ui.fms?.cruiseAltFt ?? p.profile.cruiseAltFt)}/---°`, 'big cyan') : box(8)], [], [c(p ? 'F-PLN>' : '', 'white')]),
    ]),
    lsk: {
      L1: importRoute,
      L6: (sp) => setCruise(sp),
      R6: () => goPage('legs'),
    },
  };
}

function legsPage(s) {
  if (!ui.fms) {
    return { title: s.titles.legs, rows: rows([row([], [c('NO ACTIVE ROUTE', 'amber')])]), lsk: {} };
  }
  const { waypoints, activeIndex } = ui.fms;
  const profile = ui.plan.profile;
  const start = Math.max(0, activeIndex - 1) + ui.scroll;
  const visible = waypoints.slice(start, start + 5);
  const list = visible.map((w, i) => {
    const index = start + i;
    const prev = waypoints[index - 1];
    const leg = prev ? Fms.distanceBearing(prev, w) : null;
    const planned = ui.plan.navlog.find((n) => n.ident === w.ident);
    const alt = planned ? fmtAlt(planned.altFt) : '-----';
    // The planned speed for that point's phase of flight.
    let spd = '---';
    if (index === waypoints.length - 1) spd = profile.approachKt;
    else if (index > 0 && planned) {
      spd = planned.cumNm <= profile.tocNm ? profile.climbKt : planned.cumNm >= profile.todNm ? profile.descentKt : profile.cruiseKt;
    }
    const colour = index === activeIndex ? s.colors.active : index < activeIndex ? 'white' : s.colors.legs;
    return row(
      [c(leg ? `${pad3(leg.bearingDeg)}° ${fmtNm(leg.distanceNm)}NM` : '', 'label')],
      [c(w.ident, `big ${colour}`)],
      [],
      [c(`${spd}/${alt}`, colour)],
    );
  });
  const pendingDir = ui.pending?.kind === 'dir';
  list.push(pendingDir
    ? row([], [c(s.eraseLabel, 'white')], [], [c(s.execRequired ? 'EXEC>' : 'INSERT*', 'amber')])
    : row([c('', '')], [c(`DEST ${ui.plan.destination.icao}`, 'white')], [], [c(`${fmtNm(Fms.distanceToDestination(ui.fms, ui.telemetry || waypoints[0]))}NM`, 'white')]));

  const lsk = {};
  // Typing an ident and pressing the active line = DIRECT TO (Boeing style);
  // an empty scratchpad copies that waypoint down.
  visible.forEach((w, i) => {
    lsk[`L${i + 1}`] = (sp) => {
      if (sp) requestDirectTo(sp);
      else {
        ui.scratch = w.ident;
        render();
      }
    };
  });
  lsk.L6 = () => (pendingDir ? erasePending() : null);
  lsk.R6 = () => (pendingDir ? (s.execRequired ? flash('PRESS EXEC') : execPending()) : null);
  return {
    title: `${pendingDir ? 'MOD' : 'ACT'} ${s.titles.legs}`,
    titleRight: `${Math.floor(ui.scroll / 5) + 1}/${Math.max(1, Math.ceil((waypoints.length - Math.max(0, activeIndex - 1)) / 5))}`,
    rows: rows(list),
    lsk,
  };
}

function progPage(s) {
  const g = ui.guidance;
  const t = ui.telemetry;
  const next = ui.fms ? Fms.activeWaypoint(ui.fms) : null;
  const after = ui.fms ? ui.fms.waypoints[ui.fms.activeIndex + 1] : null;
  return {
    title: s.titles.prog,
    titleRight: g ? g.phase : '',
    rows: rows([
      row([c('TO', 'label')], [c(next?.ident || '-----', `big ${s.colors.active}`)], [c('DIST   ETE', 'label')], [c(g?.lnav ? `${fmtNm(g.lnav.toDistanceNm)}  ${fmtTime((g.lnav.toDistanceNm / Math.max(60, t?.speedKt || 1)) * 60)}` : '--  --:--', 'big')]),
      row([c('NEXT', 'label')], [c(after?.ident || '-----', 'big green')], [], []),
      row([c('DEST', 'label')], [c(ui.plan?.destination.icao || '----', 'big')], [c('DIST   ETE', 'label')], [c(g ? `${fmtNm(g.distanceToDestNm)}  ${fmtTime(g.eteMin)}` : '--  --:--', 'big')]),
      row([c('CRZ ALT', 'label')], [c(fmtAlt(ui.fms?.cruiseAltFt), 'big')], [c('VNAV TGT', 'label')], [c(g ? fmtAlt(g.vnav.targetAltFt) : '-----', 'big green')]),
      row([c('XTK ERROR', 'label')], [c(g?.lnav ? `${Math.abs(g.lnav.xtkNm).toFixed(1)}${g.lnav.xtkNm >= 0 ? 'R' : 'L'}` : '--', 'big')], [c('DTK', 'label')], [c(g?.lnav ? `${pad3(g.lnav.desiredTrackDeg)}°` : '---', 'big')]),
      row([c('GS', 'label')], [c(t?.speedKt ?? '---', 'big')], [c('POS AGE', 'label')], [c(t ? `${Math.round((Date.now() - t.atMs) / 1000)}S` : '--', 'big')]),
    ]),
    lsk: { L1: () => goPage('legs') },
  };
}

function perfPage(s) {
  const p = ui.plan?.profile;
  const g = ui.guidance;
  return {
    title: s.titles.perf,
    titleRight: g?.phase || '',
    rows: rows([
      row([c('CRZ ALT', 'label')], [c(fmtAlt(ui.fms?.cruiseAltFt ?? (p ? p.cruiseAltFt : null)), 'big cyan')], [c('PHASE', 'label')], [c(g?.phase || '---', 'big green')]),
      row([c('CLB SPD', 'label')], [c(p ? `${p.climbKt}KT` : '---', 'big')], [c('CLB V/S', 'label')], [c(p ? `${p.climbFpm}` : '----', 'big')]),
      row([c('CRZ SPD', 'label')], [c(p ? `${p.cruiseKt}KT` : '---', 'big')], [c('T/C', 'label')], [c(p ? `${p.tocNm}NM` : '--', 'big')]),
      row([c('DES SPD', 'label')], [c(p ? `${p.descentKt}KT` : '---', 'big')], [c('T/D', 'label')], [c(p ? `${p.todNm}NM` : '--', 'big')]),
      row([c('APP SPD', 'label')], [c(p ? `${p.approachKt}KT` : '---', 'big')], [c('DES V/S', 'label')], [c(p ? `-${p.descentFpm}` : '----', 'big')]),
      row([c('', '')], [c(`<${s.titles.rte}`, 'white')], [], [c(`${s.titles.prog}>`, 'white')]),
    ]),
    lsk: {
      L1: (sp) => setCruise(sp),
      L6: () => goPage('rte'),
      R6: () => goPage('prog'),
    },
  };
}

function dirPage(s) {
  const upcoming = ui.fms ? ui.fms.waypoints.slice(ui.fms.activeIndex, ui.fms.activeIndex + 4) : [];
  const pendingDir = ui.pending?.kind === 'dir';
  const list = [row([c('DIR TO', 'label')], [pendingDir ? c(ui.pending.ident, 'big amber') : c('[     ]', 'cyan')])];
  for (const w of upcoming) list.push(row([], [c(`${w.ident}`, `big ${s.colors.legs}`)]));
  while (list.length < 5) list.push(blankRow());
  list.push(pendingDir
    ? row([], [c(s.eraseLabel, 'white')], [], [c(s.execRequired ? 'EXEC>' : 'INSERT*', 'amber')])
    : blankRow());
  const lsk = {
    L1: (sp) => (sp ? requestDirectTo(sp) : flash('ENTER WAYPOINT')),
    L6: () => (pendingDir ? erasePending() : null),
    R6: () => (pendingDir ? (s.execRequired ? flash('PRESS EXEC') : execPending()) : null),
  };
  upcoming.forEach((w, i) => {
    lsk[`L${i + 2}`] = () => requestDirectTo(w.ident);
  });
  return { title: s.titles.dir, rows: rows(list), lsk };
}

function menuPage(s) {
  return {
    title: s.titles.menu,
    rows: rows([
      row([], [c(`<${s.titles.rte}`, 'white')], [], [c(`${s.titles.legs}>`, 'white')]),
      row([], [c(`<${s.titles.perf}`, 'white')], [], [c(`${s.titles.prog}>`, 'white')]),
      row([], [c(`<${s.titles.dir}`, 'white')], [], []),
      row([c('PLANNER', 'label')], [c(settings.plannerUrl ? settings.plannerUrl.replace(/^https?:\/\//, '').slice(0, 22) : 'NOT SET', settings.plannerUrl ? 'green' : 'amber')]),
      row([c('AUTOPILOT INPUTS', 'label')], [c(settings.live ? 'LIVE' : 'DRY RUN', settings.live ? 'amber' : 'green')]),
      blankRow(),
    ]),
    lsk: { L1: () => goPage('rte'), R1: () => goPage('legs'), L2: () => goPage('perf'), R2: () => goPage('prog'), L3: () => goPage('dir') },
  };
}

const PAGES = { rte: routePage, legs: legsPage, prog: progPage, perf: perfPage, dir: dirPage, menu: menuPage };

// ---------------------------------------------------------------- skins

const SKINS = {
  airbus: {
    name: 'Airbus MCDU',
    execRequired: false,
    eraseLabel: '<ERASE',
    colors: { active: 'white', legs: 'green' },
    labels: { coRoute: 'CO RTE' },
    titles: { rte: 'INIT', legs: 'F-PLN', prog: 'PROG', perf: 'PERF', dir: 'DIR TO', menu: 'MCDU MENU' },
    keys: [
      ['DIR', 'dir'], ['PROG', 'prog'], ['PERF', 'perf'], ['INIT', 'rte'], ['DATA', null], ['', null],
      ['F-PLN', 'legs'], ['RAD NAV', null], ['FUEL PRED', null], ['SEC F-PLN', null], ['ATC COMM', null], ['MCDU MENU', 'menu'],
      ['AIRPORT', 'airport'], ['', null], ['←', 'prev'], ['↑', 'up'], ['→', 'next'], ['↓', 'down'],
    ],
  },
  boeing: {
    name: 'Boeing CDU',
    execRequired: true,
    eraseLabel: '<ERASE',
    colors: { active: 'magenta', legs: 'white' },
    labels: { coRoute: 'CO ROUTE' },
    titles: { rte: 'RTE 1', legs: 'RTE 1 LEGS', prog: 'PROGRESS', perf: 'CRZ', dir: 'DIR INTC', menu: 'MENU' },
    keys: [
      ['INIT REF', 'rte'], ['RTE', 'rte'], ['DEP ARR', null], ['ALTN', null], ['VNAV', 'perf'], ['', null],
      ['FIX', null], ['LEGS', 'legs'], ['HOLD', null], ['FMC COMM', null], ['PROG', 'prog'], ['EXEC', 'exec'],
      ['MENU', 'menu'], ['NAV RAD', null], ['DIR INTC', 'dir'], ['PREV PAGE', 'up'], ['NEXT PAGE', 'down'], ['', null],
    ],
  },
  bombardier: {
    name: 'Bombardier FMS',
    execRequired: true,
    eraseLabel: '<CANCEL MOD',
    colors: { active: 'magenta', legs: 'cyan' },
    labels: { coRoute: 'RTE ID' },
    titles: { rte: 'FPL', legs: 'LEGS', prog: 'PROGRESS', perf: 'PERF', dir: 'DIRECT-TO', menu: 'MENU' },
    keys: [
      ['DIR', 'dir'], ['FPL', 'rte'], ['LEGS', 'legs'], ['DEP ARR', null], ['PERF', 'perf'], ['MFD MENU', null],
      ['MFD ADV', null], ['MFD DATA', null], ['NAV', 'menu'], ['PROG', 'prog'], ['EXEC', 'exec'], ['', null],
      ['PREV', 'up'], ['NEXT', 'down'], ['', null], ['', null], ['', null], ['', null],
    ],
  },
  embraer: {
    name: 'Embraer MCDU',
    execRequired: true,
    eraseLabel: '<CANCEL',
    colors: { active: 'magenta', legs: 'green' },
    labels: { coRoute: 'LOAD RTE' },
    titles: { rte: 'RTE', legs: 'LEGS', prog: 'PROGRESS', perf: 'PERF', dir: 'DIRECT TO', menu: 'MENU' },
    keys: [
      ['NAV', 'menu'], ['RTE', 'rte'], ['PERF', 'perf'], ['PROG', 'prog'], ['DEP ARR', null], ['DIR', 'dir'],
      ['RADIO', null], ['TRS', null], ['MENU', 'menu'], ['CB', null], ['EXEC', 'exec'], ['', null],
      ['PREV', 'up'], ['NEXT', 'down'], ['', null], ['', null], ['', null], ['', null],
    ],
  },
};

function goPage(page) {
  ui.page = page;
  ui.scroll = 0;
  render();
}

function onFunctionKey(action) {
  if (!action) return flash('NOT AVAILABLE');
  if (PAGES[action]) return goPage(action);
  if (action === 'exec') return ui.pending ? execPending() : null;
  if (action === 'airport') {
    if (!ui.fms) return null;
    ui.page = 'legs';
    ui.scroll = Math.max(0, ui.fms.waypoints.length - 5 - Math.max(0, ui.fms.activeIndex - 1));
    return render();
  }
  if (action === 'up' || action === 'prev') ui.scroll = Math.max(0, ui.scroll - 5);
  if (action === 'down' || action === 'next') ui.scroll += 5;
  return render();
}

function onLsk(id) {
  const page = PAGES[ui.page](skin());
  const handler = page.lsk?.[id];
  if (!handler) return;
  const sp = ui.message ? '' : ui.scratch;
  ui.message = null;
  handler(sp);
  render();
}

function onKey(key) {
  if (ui.message) ui.message = null;
  if (key === 'CLR') ui.scratch = ui.scratch.slice(0, -1);
  else if (key === 'DEL') ui.scratch = '';
  else if (key === 'SP') ui.scratch += ' ';
  else if (key === '+/-') ui.scratch += ui.scratch.endsWith('-') ? '' : '-';
  else if (ui.scratch.length < COLS) ui.scratch += key;
  render();
}

// ---------------------------------------------------------------- autopilot modes

function syncSelectionsToAircraft() {
  const t = ui.telemetry;
  if (!t) return;
  ap.selected.headingDeg = Math.round(t.headingDeg);
  if (typeof t.speedKt === 'number') ap.selected.speedKt = Math.round(t.speedKt);
}

function setLateral(mode) {
  if (mode === 'LNAV' && !ui.fms) return flash('NO ACTIVE ROUTE');
  ap.lateral = mode;
  render();
}

function setVertical(mode) {
  if (mode === 'VNAV' && !ui.fms) return flash('NO ACTIVE ROUTE');
  ap.vertical = mode;
  if (mode === 'VNAV') ap.speedMode = 'MANAGED';
  render();
}

function altHold() {
  if (typeof ui.telemetry?.altFt === 'number') ap.selected.altFt = Math.round(ui.telemetry.altFt / 100) * 100;
  ap.vertical = 'ALT';
  render();
}

function toggleAp() {
  if (!ap.engaged) {
    if (!ui.telemetry) return flash('NO TRACKING DATA');
    if (settings.live && settings.steering === 'mouse' && !settings.mouseCenter) return flash('SET MOUSE CENTER');
    if (ap.lateral === 'HDG') ap.selected.headingDeg = Math.round(ui.telemetry.headingDeg);
    ap.disconnectReason = null;
  }
  ap.engaged = !ap.engaged;
  if (!ap.engaged) {
    api?.autopilotReleaseAll();
    api?.autopilotRecenter(null); // cancel pending nudges, leave the cursor alone
  }
  updatePassthrough();
  render();
}

function toggleAt() {
  if (!ap.autothrottle && !ui.telemetry) return flash('NO TRACKING DATA');
  if (!ap.autothrottle && ap.speedMode === 'SEL' && typeof ui.telemetry.speedKt === 'number') {
    ap.selected.speedKt = Math.round(ui.telemetry.speedKt);
  }
  ap.autothrottle = !ap.autothrottle;
  updatePassthrough();
  render();
}

function updatePassthrough() {
  api?.setFmsPassthrough(settings.live && (ap.engaged || ap.autothrottle));
}

const clampAlt = (v) => Math.max(0, Math.min(60000, v));
const wrapHdg = (v) => ((v % 360) + 360) % 360 || 360;

// A selector window: value text plus -/+ (and mouse wheel). `managed`
// windows show dashes and a dot, Airbus style.
function knob({ label, value, managed, step, bigStep, set, push, pull, pushLabel = 'PUSH', pullLabel = 'PULL' }) {
  return { type: 'knob', label, value, managed, step, bigStep, set, push, pull, pushLabel, pullLabel };
}
const button = (label, lit, onClick, cls = '') => ({ type: 'button', label, lit, onClick, cls });

function panelFor(skinId) {
  const s = ap.selected;
  // While managed, non-Airbus speed windows show the FMS target speed.
  const managedSpeed = ap.speedMode === 'MANAGED' && ui.guidance?.speedKt;
  const spdKnob = (extra = {}) => knob({ label: 'SPD', value: managedSpeed || s.speedKt, raw: () => s.speedKt, step: 1, bigStep: 10, set: (v) => (s.speedKt = Math.max(40, Math.min(600, v))), ...extra });
  const hdgKnob = (extra = {}) => knob({ label: 'HDG', value: pad3(s.headingDeg % 360 || 360), step: 1, bigStep: 10, set: (v) => (s.headingDeg = wrapHdg(v)), raw: () => s.headingDeg, ...extra });
  const altKnob = (extra = {}) => knob({ label: 'ALT', value: s.altFt, step: 100, bigStep: 1000, set: (v) => (s.altFt = clampAlt(v)), ...extra });
  const vsKnob = (extra = {}) => knob({ label: 'V/S', value: `${s.vsFpm > 0 ? '+' : ''}${s.vsFpm}`, step: 100, bigStep: 500, set: (v) => (s.vsFpm = Math.max(-6000, Math.min(6000, v))), raw: () => s.vsFpm, ...extra });

  if (skinId === 'airbus') {
    return [
      spdKnob({ managed: ap.speedMode === 'MANAGED', push: () => { ap.speedMode = 'MANAGED'; }, pull: () => { ap.speedMode = 'SEL'; } }),
      button('LOC', false, () => flash('NOT AVAILABLE')),
      { type: 'group', items: [button('AP1', ap.engaged, toggleAp), button('AP2', false, toggleAp), button('A/THR', ap.autothrottle, toggleAt)] },
      hdgKnob({ label: 'HDG', managed: ap.lateral === 'LNAV', push: () => setLateral('LNAV'), pull: () => { syncIfDashed('hdg'); setLateral('HDG'); } }),
      altKnob({ managed: ap.vertical === 'VNAV', push: () => setVertical('VNAV'), pull: () => { ap.vertical = 'ALT'; ap.speedMode = 'SEL'; } }),
      vsKnob({ managed: ap.vertical !== 'VS', push: altHold, pull: () => setVertical('VS'), pushLabel: 'LVL', pullLabel: 'PULL' }),
      button('APPR', false, () => flash('NOT AVAILABLE')),
    ];
  }
  if (skinId === 'boeing') {
    return [
      button('A/T ARM', ap.autothrottle, toggleAt, 'switch'),
      spdKnob({ label: 'IAS/MACH', managed: ap.speedMode === 'MANAGED' }),
      { type: 'group', items: [button('SPEED', ap.autothrottle && ap.speedMode === 'SEL', () => { ap.speedMode = 'SEL'; if (!ap.autothrottle) toggleAt(); }), button('VNAV', ap.vertical === 'VNAV', () => setVertical('VNAV')), button('LNAV', ap.lateral === 'LNAV', () => setLateral('LNAV'))] },
      hdgKnob({ label: 'HEADING' }),
      button('HDG SEL', ap.lateral === 'HDG', () => setLateral('HDG')),
      altKnob({ label: 'ALTITUDE' }),
      button('ALT HOLD', ap.vertical === 'ALT', altHold),
      vsKnob({ label: 'VERT SPEED' }),
      button('V/S', ap.vertical === 'VS', () => setVertical('VS')),
      { type: 'group', items: [button('CMD A', ap.engaged, toggleAp), button('A/P DISENGAGE', false, () => { if (ap.engaged) toggleAp(); }, 'disengage')] },
    ];
  }
  // Bombardier / Embraer guidance panel.
  return [
    hdgKnob({ label: 'HDG' }),
    { type: 'group', items: [button('HDG', ap.lateral === 'HDG', () => setLateral('HDG')), button('NAV', ap.lateral === 'LNAV', () => setLateral('LNAV')), button('APPR', false, () => flash('NOT AVAILABLE'))] },
    { type: 'group', items: [button('AP', ap.engaged, toggleAp), button('YD', ap.engaged, () => {}), button('A/T', ap.autothrottle, toggleAt)] },
    spdKnob({ label: 'SPD', managed: ap.speedMode === 'MANAGED', push: () => { ap.speedMode = ap.speedMode === 'MANAGED' ? 'SEL' : 'MANAGED'; }, pushLabel: 'FMS' }),
    { type: 'group', items: [button(skinId === 'embraer' ? 'FLCH' : 'FLC', false, () => { ap.vertical = 'ALT'; render(); }), button('VS', ap.vertical === 'VS', () => setVertical('VS')), button('VNAV', ap.vertical === 'VNAV', () => setVertical('VNAV')), button('ALT', ap.vertical === 'ALT', altHold)] },
    altKnob({ label: 'ALT' }),
    vsKnob({ label: skinId === 'embraer' ? 'VS/FPA' : 'VS' }),
  ];
}

function syncIfDashed() {
  if (ap.lateral === 'LNAV' && ui.guidance?.lnav) ap.selected.headingDeg = ui.guidance.lnav.headingDeg;
}

// Flight mode annunciator text per skin: [speed, lateral, vertical, ap].
function fmaColumns(skinId) {
  const vnavPhase = ui.guidance?.phase;
  const managedVert = { CLB: 'CLB', CRZ: 'ALT CRZ', DES: 'DES', APP: 'DES', DONE: 'ALT' }[vnavPhase] || 'CLB';
  const vsText = `V/S ${ap.selected.vsFpm > 0 ? '+' : ''}${ap.selected.vsFpm}`;
  if (skinId === 'airbus') {
    return [
      ap.autothrottle ? 'SPEED' : '',
      ap.vertical === 'VNAV' ? managedVert : ap.vertical === 'VS' ? vsText : 'ALT',
      ap.lateral === 'LNAV' ? 'NAV' : 'HDG',
      [ap.engaged ? 'AP1' : '', ap.autothrottle ? 'A/THR' : ''].filter(Boolean).join(' '),
    ];
  }
  const pitch = ap.vertical === 'VNAV' ? (vnavPhase === 'CRZ' ? 'VNAV PTH' : 'VNAV SPD') : ap.vertical === 'VS' ? 'V/S' : 'ALT HOLD';
  if (skinId === 'boeing') {
    return [ap.autothrottle ? (ap.vertical === 'VNAV' && vnavPhase === 'CLB' ? 'N1' : 'MCP SPD') : '', ap.lateral === 'LNAV' ? 'LNAV' : 'HDG SEL', pitch, ap.engaged ? 'CMD' : ''];
  }
  return [ap.autothrottle ? 'SPD' : '', ap.lateral === 'LNAV' ? 'LNAV' : 'HDG', ap.vertical === 'VNAV' ? 'VPTH' : ap.vertical === 'VS' ? 'VS' : 'ALT', [ap.engaged ? 'AP' : '', ap.engaged ? 'YD' : ''].filter(Boolean).join(' ')];
}

// ---------------------------------------------------------------- view model + input
//
// Everything on screen comes from buildView(), a plain object fmsView.js
// draws - here, and on the remote-control page (sent via main.js). Every
// input, from this window or a remote, arrives as a message at
// handleInput(), so both control the same aircraft identically.

const panelHandlers = new Map(); // panel control id -> its knob/button definition

function buildPanel(skinId) {
  panelHandlers.clear();
  let next = 0;
  const serialize = (item) => {
    if (item.type === 'group') return { type: 'group', items: item.items.map(serialize) };
    const id = `c${next++}`;
    panelHandlers.set(id, item);
    if (item.type === 'button') return { type: 'button', id, label: item.label, lit: Boolean(item.lit), cls: item.cls || '' };
    return {
      type: 'knob', id, label: item.label, value: String(item.value), managed: Boolean(item.managed),
      step: item.step, bigStep: item.bigStep,
      pushLabel: item.push ? item.pushLabel : null, pullLabel: item.pull ? item.pullLabel : null,
    };
  };
  return panelFor(skinId).map(serialize);
}

function buildStatus() {
  const t = ui.telemetry;
  const age = t ? Math.round((Date.now() - t.atMs) / 1000) : null;
  const g = ui.guidance;
  const tg = Autopilot.targets(ap, g);
  return {
    trackText: t ? `TRACKING ${age}s ago` : 'NO TRACKING DATA',
    trackGood: Boolean(t && age < 15),
    readout: [
      ['Aircraft', t?.aircraftType || '—'],
      ['Heading', t ? `${pad3(t.headingDeg)}°` : '—', `target ${pad3(tg.headingDeg)}°`],
      ['Altitude', t?.altFt != null ? `${t.altFt} ft` : '—', `target ${tg.altFt} ft`],
      ['Speed', t?.speedKt != null ? `${t.speedKt} kt` : '—', `target ${tg.speedKt} kt`],
      ['Next waypoint', g?.lnav ? `${g.lnav.toIdent} ${fmtNm(g.lnav.toDistanceNm)} nm` : '—'],
      ['Phase', g?.phase || '—'],
    ],
    live: settings.live,
    log: ui.lastInputs,
  };
}

function buildView() {
  const skinId = currentSkinId();
  const s = SKINS[skinId];
  const page = PAGES[ui.page](s);
  return {
    skin: skinId,
    screen: {
      title: page.title,
      titleRight: page.titleRight || '',
      rows: page.rows,
      scratch: ui.message
        ? { text: ui.message, cls: ui.message === 'LOADING...' ? 'white' : 'amber' }
        : { text: ui.scratch, cls: '' },
    },
    fkeys: s.keys.map(([label, action]) => ({ label, exec: action === 'exec' })),
    execLit: Boolean(ui.pending),
    panel: buildPanel(skinId),
    fma: { cols: fmaColumns(skinId), warn: ap.disconnectReason || '' },
    status: buildStatus(),
  };
}

function render() {
  const vm = buildView();
  FmsView.render(vm);
  api?.publishFmsView?.(vm);
}

const KEYPAD = new Set('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789./'.split('').concat(['SP', 'DEL', 'CLR', '+/-']));

/** The one entry point for every cockpit input - local clicks and remotes. */
function handleInput(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'lsk' && /^[LR][1-6]$/.test(msg.id)) return onLsk(msg.id);
  if (msg.type === 'key' && KEYPAD.has(msg.ch)) return onKey(msg.ch);
  if (msg.type === 'fkey' && Number.isInteger(msg.index)) {
    const key = skin().keys[msg.index];
    if (key && key[0]) onFunctionKey(key[1]);
    return null;
  }
  if (msg.type === 'panel') {
    const item = panelHandlers.get(msg.id);
    if (!item) return null;
    if (item.type === 'button' && msg.action === 'click') item.onClick();
    else if (item.type === 'knob') {
      const current = Number(String(item.raw ? item.raw() : item.value).replace(/[^\d-]/g, ''));
      const step = msg.big ? item.bigStep : item.step;
      if (msg.action === 'inc') item.set(current + step);
      else if (msg.action === 'dec') item.set(current - step);
      else if (msg.action === 'push' && item.push) item.push();
      else if (msg.action === 'pull' && item.pull) item.pull();
    }
    return render();
  }
  // A remote may switch the autopilot to DRY RUN, never to LIVE - going
  // LIVE stays a deliberate choice made at the PC, behind its warning.
  if (msg.type === 'dry-run' && settings.live) {
    settings.live = false;
    api?.autopilotReleaseAll();
    api?.autopilotRecenter(null);
    updatePassthrough();
    return render();
  }
  return null;
}

// ---------------------------------------------------------------- control loop

const AXIS_KEYS = { roll: ['rollLeft', 'rollRight'], pitch: ['pitchDown', 'pitchUp'], throttle: ['throttleDown', 'throttleUp'] };

function logInput(text) {
  const time = new Date().toLocaleTimeString([], { hour12: false });
  ui.lastInputs.unshift(`${time}  ${text}`);
  ui.lastInputs = ui.lastInputs.slice(0, 12);
}

function disconnectAp(reason) {
  ap.engaged = false;
  ap.disconnectReason = reason;
  api?.autopilotRecenter(null);
  updatePassthrough();
}

async function sendCommands(commands) {
  const byAxis = Object.fromEntries(commands.map((cmd) => [cmd.axis, cmd]));

  // Pitch and bank: one mouse nudge covering both axes (PTFS), or keys.
  if (settings.steering === 'mouse' && (byAxis.roll || byAxis.pitch)) {
    const { roll, pitch } = byAxis;
    const parts = [];
    if (roll) parts.push(`${roll.direction > 0 ? 'right' : 'left'} ${roll.ms}ms`);
    if (pitch) parts.push(`${pitch.direction > 0 ? 'nose up' : 'nose down'} ${pitch.ms}ms`);
    logInput(`mouse ${parts.join(', ')}`);
    if (settings.live) {
      if (!settings.mouseCenter) {
        disconnectAp('Set the mouse center in Settings - autopilot disconnected');
      } else {
        const result = await api?.autopilotSteer({
          center: settings.mouseCenter,
          deflectionPx: settings.mouseDeflectionPx,
          invertPitch: settings.invertPitch,
          roll: roll ? { direction: roll.direction, ms: roll.ms } : null,
          pitch: pitch ? { direction: pitch.direction, ms: pitch.ms } : null,
        });
        if (result?.override) disconnectAp('Mouse moved - autopilot disconnected');
      }
    }
  }

  for (const cmd of commands) {
    if (settings.steering === 'mouse' && cmd.axis !== 'throttle') continue;
    const key = settings.keymap[AXIS_KEYS[cmd.axis][cmd.direction > 0 ? 1 : 0]];
    if (settings.live) api?.autopilotPress(key, cmd.ms);
    logInput(`${key} ${cmd.ms}ms  (${cmd.axis} ${cmd.direction > 0 ? '+' : '−'})`);
  }
}

async function onTelemetry(sample) {
  const first = !ui.telemetry;
  ui.telemetry = sample;
  if (first) syncSelectionsToAircraft();
  if (ui.fms) ui.guidance = Fms.guidance(ui.fms, { lat: sample.lat, lon: sample.lon }, sample);

  const out = Autopilot.update(ap, sample, ui.guidance);
  if (out.disconnected) {
    api?.autopilotReleaseAll();
    api?.autopilotRecenter(null);
    updatePassthrough();
  }
  await sendCommands(out.commands);
  render();
}

// ---------------------------------------------------------------- settings UI

async function loadSettings() {
  const saved = (await api?.loadFmsSettings?.()) || {};
  Object.assign(settings, saved, { keymap: { ...DEFAULT_KEYMAP, ...(saved.keymap || {}) }, live: false });
  $('planner-url').value = settings.plannerUrl || '';
  $('skin-select').value = settings.skin || 'auto';
  $('steering').value = settings.steering;
  $('deflection').value = settings.mouseDeflectionPx;
  $('invert-pitch').checked = settings.invertPitch;
  showMouseCenter();
  syncSteeringVisibility();
  // Settings saved before remote modes existed had a plain on/off.
  if (saved.remoteEnabled && !saved.remoteMode) settings.remoteMode = 'lan';
  $('remote-mode').value = settings.remoteMode;
}

function saveSettings() {
  const { live, ...persisted } = settings;
  return api?.saveFmsSettings?.(persisted);
}

async function buildKeymapEditor() {
  const names = (await api?.autopilotKeyNames?.()) || Object.values(DEFAULT_KEYMAP);
  const box = $('keymap');
  box.innerHTML = '';
  for (const [action, label] of Object.entries(KEYMAP_LABELS)) {
    const line = document.createElement('div');
    line.className = `keymap-row ${action.startsWith('throttle') ? '' : 'steer-keys'}`;
    line.innerHTML = `<span>${label}</span>`;
    const select = document.createElement('select');
    for (const n of names) select.append(new Option(n, n));
    select.value = settings.keymap[action];
    select.addEventListener('change', () => { settings.keymap[action] = select.value; });
    const test = document.createElement('button');
    test.className = 'btn secondary small';
    test.textContent = 'Test';
    test.title = 'Presses this key for 0.3 s after a 3 s delay - click into PTFS in the meantime';
    test.addEventListener('click', () => {
      $('settings-msg').textContent = `Pressing ${select.value} in 3 s - click into PTFS now`;
      setTimeout(() => {
        api?.autopilotPress(select.value, 300);
        $('settings-msg').textContent = `Pressed ${select.value}`;
      }, 3000);
    });
    line.append(select, test);
    box.append(line);
  }
  syncSteeringVisibility();
}

$('settings-toggle').addEventListener('click', () => {
  const open = $('settings-panel').hidden;
  $('settings-panel').hidden = !open;
  $('status-panel').hidden = open;
});
$('save-settings').addEventListener('click', async () => {
  settings.plannerUrl = $('planner-url').value.trim();
  settings.mouseDeflectionPx = Math.max(10, Math.min(1000, Number($('deflection').value) || 120));
  settings.invertPitch = $('invert-pitch').checked;
  ui.navdata = null;
  await saveSettings();
  loadNavdata();
  if (settings.remoteMode === 'relay') startRemote(); // the relay lives at the planner URL
  $('settings-msg').textContent = 'Saved';
  render();
});
function showMouseCenter() {
  const c = settings.mouseCenter;
  $('mouse-center').textContent = c ? `${Math.round(c.x)}, ${Math.round(c.y)}` : 'not set';
}

function syncSteeringVisibility() {
  const mouse = settings.steering === 'mouse';
  $('mouse-settings').hidden = !mouse;
  for (const el of document.querySelectorAll('.steer-keys')) el.hidden = mouse;
}

// Every capture/test waits 3 s, so the pilot can move over to PTFS first.
function countdown(message, fn) {
  let left = 3;
  const tick = () => {
    if (left === 0) return fn();
    $('settings-msg').textContent = `${message} in ${left}…`;
    left -= 1;
    setTimeout(tick, 1000);
  };
  tick();
}

$('steering').addEventListener('change', () => {
  settings.steering = $('steering').value;
  syncSteeringVisibility();
});
$('capture-center').addEventListener('click', () => {
  countdown('Hold your mouse where the aircraft flies straight and level - capturing', async () => {
    settings.mouseCenter = await api?.autopilotCursor();
    showMouseCenter();
    await saveSettings();
    $('settings-msg').textContent = 'Center captured and saved';
  });
});
for (const [id, axis, direction, label] of [
  ['test-bank-right', 'roll', 1, 'bank right'],
  ['test-nose-up', 'pitch', 1, 'nose up'],
]) {
  $(id).addEventListener('click', () => {
    if (!settings.mouseCenter) {
      $('settings-msg').textContent = 'Capture the center first';
      return;
    }
    countdown(`Click into PTFS - nudging ${label}`, async () => {
      settings.mouseDeflectionPx = Number($('deflection').value) || 120;
      settings.invertPitch = $('invert-pitch').checked;
      await api?.autopilotSteer({
        center: settings.mouseCenter,
        deflectionPx: settings.mouseDeflectionPx,
        invertPitch: settings.invertPitch,
        [axis]: { direction, ms: 500 },
      });
      $('settings-msg').textContent = `Nudged ${label} for 0.5 s`;
    });
  });
}

// ---------------------------------------------------------------- phone / tablet control

const formatRelayCode = (code) => (code || '').match(/.{1,4}/g)?.join('-') || '';

function showRemoteInfo(urls, code) {
  $('remote-urls').textContent = urls;
  $('remote-code').textContent = code;
  $('remote-info').hidden = false;
}

async function startLan() {
  if (!settings.remoteCode) {
    // Saved, so a paired phone keeps working after the app restarts.
    settings.remoteCode = await api.remoteNewCode();
    await saveSettings();
  }
  try {
    const { urls } = await api.remoteStart({ port: settings.remotePort, code: settings.remoteCode });
    showRemoteInfo(urls.length ? urls.join('  or  ') : `http://<this PC's IP>:${settings.remotePort}`, settings.remoteCode);
  } catch (err) {
    $('remote-error').textContent = err.code === 'EADDRINUSE'
      ? `Port ${settings.remotePort} is already in use by another program.`
      : `Could not start remote control: ${err.message}`;
  }
}

async function startRelay() {
  if (!settings.plannerUrl) {
    $('remote-error').textContent = 'Set the Flight planner URL above first - the phone connects through it.';
    return;
  }
  if (!settings.relayCode || !settings.relaySecret) {
    const { code, secret } = await api.relayNewCredentials();
    Object.assign(settings, { relayCode: code, relaySecret: secret });
    await saveSettings();
  }
  showRemoteInfo(`${settings.plannerUrl.replace(/\/$/, '')}/remote/`, formatRelayCode(settings.relayCode));
  $('remote-clients').textContent = 'Connecting to the flight planner…';
  api.relayStart({ baseUrl: settings.plannerUrl, code: settings.relayCode, secret: settings.relaySecret });
}

async function startRemote() {
  $('remote-error').textContent = '';
  $('remote-info').hidden = true;
  await api.remoteStop();
  await api.relayStop();
  if (settings.remoteMode === 'lan') await startLan();
  if (settings.remoteMode === 'relay') await startRelay();
  render(); // so a phone that connects straight away has a view
}

$('remote-mode').addEventListener('change', async () => {
  settings.remoteMode = $('remote-mode').value;
  await saveSettings();
  startRemote();
});
$('remote-new-code').addEventListener('click', async () => {
  if (settings.remoteMode === 'relay') {
    // Old code stops working; every phone must enter the new one.
    const { code, secret } = await api.relayNewCredentials();
    Object.assign(settings, { relayCode: code, relaySecret: secret });
  } else {
    settings.remoteCode = await api.remoteNewCode();
    await api.remoteSetCode(settings.remoteCode);
    $('remote-code').textContent = settings.remoteCode;
  }
  await saveSettings();
  if (settings.remoteMode === 'relay') startRemote();
});
api?.onRemoteClients?.((count) => {
  const none = settings.remoteMode === 'relay' ? 'Online - waiting for a device' : 'No devices connected';
  $('remote-clients').textContent = count ? `${count} device${count > 1 ? 's' : ''} connected` : none;
});
api?.onRelayStatus?.(async ({ state, detail }) => {
  if (state === 'connected') $('remote-clients').textContent = 'Online - waiting for a device';
  else if (state === 'offline') $('remote-clients').textContent = `Can't reach the flight planner (${detail}) - retrying…`;
  else if (state === 'error' && detail === 'conflict') {
    // Someone else has this code (vanishingly unlikely) - take a new one.
    const { code, secret } = await api.relayNewCredentials();
    Object.assign(settings, { relayCode: code, relaySecret: secret });
    await saveSettings();
    startRemote();
  } else if (state === 'error') $('remote-error').textContent = `Remote control stopped: ${detail}. Check the Flight planner URL.`;
});

$('skin-select').addEventListener('change', () => {
  settings.skin = $('skin-select').value;
  saveSettings();
  render();
});
$('live-toggle').addEventListener('click', () => {
  if (settings.live) {
    settings.live = false;
    api?.autopilotReleaseAll();
    updatePassthrough();
    return render();
  }
  $('live-dialog').showModal();
});
$('live-dialog').addEventListener('close', () => {
  if ($('live-dialog').returnValue === 'ok') {
    settings.live = true;
    updatePassthrough();
  }
  render();
});

(async function init() {
  await loadSettings();
  await buildKeymapEditor();
  ui.page = 'rte';
  FmsView.mount(handleInput);
  api?.onTelemetry(onTelemetry);
  api?.onRemoteInput?.(handleInput);
  setInterval(render, 1000); // keeps ages/ETEs ticking, here and on remotes
  render();
  if (settings.remoteMode !== 'off' && api?.remoteStart) startRemote();
  loadNavdata();
})();
