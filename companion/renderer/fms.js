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

// Aircraft names as the HUD shows them -> FMS style. Anything not listed
// (An-225, C-130, fighters, light aircraft...) gets the Default FMS.
const HUD_TYPE_SKINS = [
  [/airbus a220/i, 'a220'],
  [/airbus a3[58]0/i, 'a350'],
  [/airbus|a330 mrtt/i, 'airbus'],
  [/boeing 787/i, 'boeing787'],
  [/boeing|douglas md|\bc40\b|kc-?7[06]7|707af1|747af1|dreamlifter|\bp8\b|c-32|e-3 sentry|ec-18b/i, 'boeing'],
  [/e190|embraer/i, 'embraer'],
];

// ---------------------------------------------------------------- state

const settings = {
  plannerUrl: '',
  skin: 'auto',
  tuning: {}, // autopilot gains changed from the defaults (see Autopilot.TUNABLE)
  panel: 'auto', // auto = FCU for Airbus A320/330/340, MCP for other jets; native = the simple panel of each FMS style
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
  flightLog: [], // CSV rows, see Autopilot.logRow
  calib: null, // a running calibration test
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
  // A style picked by hand - unless it no longer exists, then Auto.
  if (settings.skin !== 'auto' && SKINS[settings.skin]) return settings.skin;
  const hudType = ui.telemetry?.aircraftType || '';
  for (const [re, skin] of HUD_TYPE_SKINS) if (re.test(hudType)) return skin;
  const fromPlan = ui.plan?.aircraft?.fms;
  return SKINS[fromPlan] ? fromPlan : 'generic';
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
  if (s.initPage === 'airbus') return airbusInitPage(s);
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
function airbusInitPage(s) {
  const p = ui.plan;
  const box = (n) => c('□'.repeat(n), 'amber');
  return {
    title: s.titles.rte,
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
    // A chart restriction beats the planned altitude: 3000A = at or above, 1500B = at or below.
    const restriction = w.altAtFt != null ? `${w.altAtFt}` : w.altMinFt != null ? `${w.altMinFt}A` : w.altMaxFt != null ? `${w.altMaxFt}B` : null;
    const alt = restriction || (planned ? fmtAlt(planned.altFt) : '-----');
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
  // The last line always sits on the 6th line select key, however few
  // waypoints are showing above it.
  while (list.length < 5) list.push(blankRow());
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
    title: s.actPrefix === false
      ? `${s.titles.legs}${pendingDir ? ' (TMPY)' : ''}`
      : `${pendingDir ? 'MOD' : 'ACT'} ${s.titles.legs}`,
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
    initPage: 'airbus',
    execRequired: false,
    eraseLabel: '<ERASE',
    colors: { active: 'white', legs: 'green' },
    labels: { coRoute: 'CO RTE' },
    titles: { rte: 'INIT', legs: 'F-PLN', prog: 'PROG', perf: 'PERF', dir: 'DIR TO', menu: 'MCDU MENU' },
    // Layout from an A320-family MCDU: two rows of page keys with BRT/DIM
    // at the end, AIRPORT and the arrow keys above the number pad on the
    // left, and FM1/IND/RDY/FM2 lights above the screen.
    keyCols: 7,
    keys: [
      ['DIR', 'dir'], ['PROG', 'prog'], ['PERF', 'perf'], ['INIT', 'rte'], ['DATA', null], ['', 'blank'], ['BRT', 'noop', 'small'],
      ['F-PLN', 'legs'], ['RAD NAV', null], ['FUEL PRED', null], ['SEC F-PLN', null], ['ATC COMM', null], ['MCDU MENU', 'menu'], ['DIM', 'noop', 'small'],
      ['AIR PORT', 'airport', 'nav'], ['', 'blank', 'nav'], ['←', 'prev', 'nav arrow'], ['↑', 'up', 'nav arrow'], ['→', 'next', 'nav arrow'], ['↓', 'down', 'nav arrow'],
    ],
    alpha: [...'ABCDEFGHIJKLMNOPQRSTUVWXY', 'Z', '/', 'SP', 'OVFY', 'CLR'],
    annunciators: [['FM1', ''], ['IND', ''], ['RDY', 'on'], ['', ''], ['FM2', '']],
  },
  // A350 / A380: no MCDU. The FMS is a set of pages on the MFD - tabs
  // across the top, a title bar, fields and buttons clicked with the
  // trackball - typed into from the KCCU (QWERTY keyboard, page keys, number
  // pad). Here each page's left/right lines are clickable fields: click one
  // to put what you typed into it (or press ENT after clicking it).
  a350: {
    name: 'A350/A380 MFD',
    execRequired: false,
    screenStyle: 'mfd',
    initPage: 'airbus',
    actPrefix: false,
    eraseLabel: 'ERASE',
    colors: { active: 'white', legs: 'green' },
    labels: { coRoute: 'CO RTE' },
    titles: { rte: 'ACTIVE/INIT', legs: 'ACTIVE/F-PLN', prog: 'POSITION/MONITOR', perf: 'ACTIVE/PERF', dir: 'ACTIVE/F-PLN/DIRECT TO', menu: 'DATA/STATUS' },
    keyCols: 7,
    keys: [
      // MFD tabs (drawn across the top of the display)
      ['ACTIVE', 'legs', 'tab'], ['POSITION', 'prog', 'tab'], ['SEC INDEX', null, 'tab'], ['DATA', 'menu', 'tab'],
      // KCCU page keys
      ['ESC', 'clrinfo'], ['↑', 'up', 'arrow'], ['DIR', 'dir'], ['PERF', 'perf'], ['INIT', 'rte'], ['NAV AID', null], ['C/L MENU', null],
      ['CLR INFO', 'clrinfo'], ['↓', 'down', 'arrow'], ['F-PLN', 'legs'], ['DEST', 'airport'], ['SEC INDEX', null], ['SURV', null], ['ATC COM', null],
      // display selection keys beside the trackball
      ['OIS', 'noop', 'nav'], ['ND', 'noop', 'nav'], ['MFD', 'noop', 'nav on'], ['MAIL BOX', 'noop', 'nav'], ['◀◀', 'up', 'nav'], ['▶▶', 'down', 'nav'],
    ],
    alpha: [...'QWERTYUIOP', '←', ...'ASDFGHJKL', 'NOTE PAD', '/', ...'ZXCVBNM', 'SPACE', 'ENT'],
  },
  boeing: {
    name: 'Boeing CDU',
    execRequired: true,
    eraseLabel: '<ERASE',
    colors: { active: 'magenta', legs: 'white' },
    labels: { coRoute: 'CO ROUTE' },
    titles: { rte: 'RTE 1', legs: 'RTE 1 LEGS', prog: 'PROGRESS', perf: 'CRZ', dir: 'DIR INTC', menu: 'MENU' },
    // Layout from a 777-style CDU: two rows of page keys (EXEC with its
    // light bar at the end of the second, the BRT knob above it), then
    // MENU / NAV RAD / PREV PAGE / NEXT PAGE above the number pad on the
    // left. Direct-to is done on LEGS: type the waypoint onto 1L.
    keyCols: 6,
    keys: [
      ['INIT REF', 'rte'], ['RTE', 'rte'], ['DEP ARR', null], ['ATC', null], ['VNAV', 'perf'], ['', 'knob'],
      ['FIX', null], ['LEGS', 'legs'], ['HOLD', null], ['FMC COMM', null], ['PROG', 'prog'], ['EXEC', 'exec'],
      ['MENU', 'menu', 'nav'], ['NAV RAD', null, 'nav'], ['PREV PAGE', 'up', 'nav'], ['NEXT PAGE', 'down', 'nav'],
    ],
    alpha: [...'ABCDEFGHIJKLMNOPQRSTUVWXY', 'Z', 'SP', 'DEL', '/', 'CLR'],
  },
  // Boeing 787: no separate CDU unit - the CDU is drawn on the lower
  // display (soft line select and page keys around a black text window),
  // with a physical keypad panel beside it (LOWER MFD select keys, round
  // number and letter keys).
  boeing787: {
    name: 'Boeing 787 CDU',
    execRequired: true,
    eraseLabel: '<ERASE',
    colors: { active: 'magenta', legs: 'white' },
    labels: { coRoute: 'CO ROUTE' },
    titles: { rte: 'RTE 1', legs: 'RTE 1 LEGS', prog: 'PROGRESS', perf: 'CRZ', dir: 'DIR INTC', menu: 'MENU' },
    keyCols: 5,
    keys: [
      ['INIT REF', 'rte'], ['RTE', 'rte'], ['DEP ARR', null], ['ALTN', null], ['VNAV', 'perf'],
      ['FIX', null], ['LEGS', 'legs'], ['HOLD', null], ['FMC COMM', null], ['PROG', 'prog'],
      ['NAV RAD', null], ['OFST', null], ['RTA', null], ['PREV PAGE', 'up'], ['NEXT PAGE', 'down'],
      ['EXEC', 'exec'], ['', null], ['', null], ['', null], ['', null],
      ['SYS', 'noop', 'nav mfd'], ['CDU', 'noop', 'nav mfd on'], ['INFO', 'noop', 'nav mfd'],
      ['CHKL', 'noop', 'nav mfd'], ['COMM', 'noop', 'nav mfd'], ['ND', 'noop', 'nav mfd'],
    ],
    alpha: [...'ABCDEFGHIJKLMNOPQRSTUVWXY', 'Z', 'SP', 'DEL', '/', 'CLR'],
  },
  // A220 (Collins Pro Line Fusion), from a photo: FMS pages on the centre
  // display - a top tab row (ACT, DBASE, POS, FPLN, PERF, ROUTE), a second
  // row that depends on the page, fields and buttons clicked with the
  // cursor, THRUST... / MSG... along the bottom - typed into from the MKP
  // keyboard (round letter keys with the number pad in the same block).
  // Changes need EXEC; CNCL cancels them.
  a220: {
    name: 'A220 FMS',
    execRequired: true,
    screenStyle: 'fusion',
    actPrefix: false,
    eraseLabel: 'CANCEL',
    colors: { active: 'magenta', legs: 'white' },
    labels: { coRoute: 'CO ROUTE' },
    titles: { rte: 'ROUTE', legs: 'ACTIVE FLIGHT PLAN', prog: 'POSITION', perf: 'PERFORMANCE', dir: 'DIRECT TO', menu: 'DATABASE' },
    keyCols: 7,
    keys: [
      // display: top tabs, then the second-row tabs for the PERF pages and for the rest
      ['ACT', 'noop', 'tab'], ['DBASE', 'menu', 'tab'], ['POS', 'prog', 'tab'], ['FPLN', 'legs', 'tab'], ['PERF', 'perf', 'tab'], ['ROUTE', 'rte', 'tab'],
      ['DEP', 'perf', 'subtab perf'], ['CLB', 'perf', 'subtab perf'], ['CRZ', 'perf', 'subtab perf'], ['DES', 'perf', 'subtab perf'], ['ARR', 'perf', 'subtab perf'],
      ['LEGS', 'legs', 'subtab'], ['VIA/TO', 'rte', 'subtab'], ['POS REPORT', 'prog', 'subtab'], ['FLT LOG', null, 'subtab'],
      ['THRUST', 'perf', 'bottom'], ['MSG', 'clrinfo', 'bottom'],
      // MKP: top row
      ['MSG', 'clrinfo'], ['ROUTE', 'rte'], ['DIR', 'dir'], ['DEP ARR', null], ['', null], ['CNCL', 'cncl'], ['EXEC', 'exec'],
      // MKP: bottom rows
      ['MAP', 'noop', 'nav'], ['FMS', 'legs', 'nav'], ['CKS', 'noop', 'nav'], ['↑', 'up', 'nav arrow'], ['PREV', 'up', 'nav'], ['NEXT', 'down', 'nav'], ['', null, 'nav'],
      ['CHKL', 'noop', 'nav'], ['SYN', 'noop', 'nav'], ['DATA', 'menu', 'nav'], ['←', 'up', 'nav arrow'], ['↓', 'down', 'nav arrow'], ['→', 'down', 'nav arrow'], ['CAS', 'noop', 'nav'],
    ],
    alpha: [
      'A', 'B', 'C', 'D', 'E', 'F', '1', '2', '3', 'CLR DEL',
      'G', 'H', 'I', 'J', 'K', 'L', '4', '5', '6', 'ENTER',
      'M', 'N', 'O', 'P', 'Q', 'R', '7', '8', '9', '',
      'S', 'T', 'U', 'V', 'W', 'X', '+/-', '0', '.', '',
      'Y', 'Z', 'SP', '/', '', '', '', '', '', '',
    ],
    alphaCols: 10,
    numeric: [],
  },
  // Layout from an E-Jet (Honeywell Primus Epic) MCDU: blue-grey unit,
  // PERF/NAV/PREV/FPL/PROG/RTE/CB with BRT-DIM, then MENU/DLK/NEXT/TRS/RADIO
  // and the big knob; six-wide letters with the last two rows shifted
  // right, and a four-wide number pad. No EXEC key - changes go in
  // straight away, as on the real unit.
  embraer: {
    name: 'Embraer MCDU',
    execRequired: false,
    actPrefix: false,
    eraseLabel: '<CANCEL',
    colors: { active: 'magenta', legs: 'cyan' },
    labels: { coRoute: 'LOAD RTE' },
    titles: { rte: 'ROUTE', legs: 'ACTIVE FLT PLAN', prog: 'PROGRESS', perf: 'PERFORMANCE', dir: 'DIRECT TO', menu: 'NAV INDEX' },
    keyCols: 8,
    keys: [
      ['PERF', 'perf'], ['NAV', 'menu'], ['PREV', 'up', 'boxed'], ['FPL', 'legs'], ['PROG', 'prog'], ['RTE', 'rte'], ['CB', null], ['BRT DIM', 'noop', 'small'],
      ['MENU', 'menu'], ['DLK', null], ['NEXT', 'down', 'boxed'], ['', 'blank'], ['TRS', null], ['RADIO', null], ['', null], ['', 'knob'],
    ],
    alpha: [...'ABCDEF', ...'GHIJKL', ...'MNOPQR', '', ...'STUVW', '', 'X', 'Y', 'Z', 'DEL', 'CLR'],
    alphaCols: 6,
    numeric: ['1', '2', '3', '+/-', '4', '5', '6', '.', '7', '8', '9', '', '/', '0', 'SP', ''],
    numericCols: 4,
  },
  // Default FMS: a neutral unit for every aircraft without a
  // manufacturer style of its own (An-225, C-130, fighters, light aircraft...).
  generic: {
    name: 'Default FMS',
    execRequired: true,
    eraseLabel: '<CANCEL',
    colors: { active: 'magenta', legs: 'green' },
    labels: { coRoute: 'PLAN ID' },
    titles: { rte: 'ROUTE', legs: 'LEGS', prog: 'PROGRESS', perf: 'PERF', dir: 'DIRECT TO', menu: 'MENU' },
    keys: [
      ['ROUTE', 'rte'], ['LEGS', 'legs'], ['DIR', 'dir'], ['PERF', 'perf'], ['PROG', 'prog'], ['MENU', 'menu'],
      ['PREV', 'up'], ['NEXT', 'down'], ['', null], ['', null], ['', null], ['EXEC', 'exec'],
    ],
  },
};

function goPage(page) {
  ui.page = page;
  ui.scroll = 0;
  render();
}

const DEFAULT_ALPHA = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'SP', 'DEL', '/', 'CLR'];
const DEFAULT_NUMERIC = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '+/-'];
// Key actions that do nothing on purpose: lighting controls and blank keys.
const INERT_KEYS = new Set(['noop', 'blank', 'knob']);

function onFunctionKey(action) {
  if (INERT_KEYS.has(action)) return null;
  if (action === 'clrinfo') {
    ui.message = null;
    return render();
  }
  if (action === 'cncl') return ui.pending ? erasePending() : null;
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
  ui.selectedField = id; // the A350's ENT key puts the entry into the last field clicked
  const page = PAGES[ui.page](skin());
  const handler = page.lsk?.[id];
  if (!handler) return;
  const sp = ui.message ? '' : ui.scratch;
  ui.message = null;
  handler(sp);
  render();
}

// KCCU keys that mean the same as MCDU ones.
const KEY_ALIASES = { '←': 'CLR', SPACE: 'SP', 'CLR DEL': 'CLR', ENTER: 'ENT' };

function onKey(rawKey) {
  const key = KEY_ALIASES[rawKey] || rawKey;
  if (key === 'OVFY' || key === 'NOTE PAD') return flash('NOT AVAILABLE'); // no fly-over waypoints / notepad here
  if (key === 'ENT') return ui.selectedField ? onLsk(ui.selectedField) : flash('SELECT A FIELD');
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

// Which autopilot panel to draw: Airbus A320/330/340 get the FCU, A350/A380 their
// own FCU, the A220 its flight control panel, the Embraer E-Jet its guidance panel, every other jet the Boeing MCP, and turboprops, light aircraft and helicopters keep the
// simple panel of their FMS style. Settings can switch back to the simple one.
const JET_CATEGORIES = new Set(['narrowbody', 'widebody', 'regionaljet', 'bizjet', 'supersonic']);
function panelStyle(skinId) {
  if (settings.panel === 'native') return 'native';
  if (skinId === 'airbus') return 'fcu';
  if (skinId === 'a350') return 'fcu350';
  if (skinId === 'a220') return 'fcp';
  if (skinId === 'embraer') return 'gp';
  if (['boeing', 'boeing787'].includes(skinId)) return 'mcp';
  if (skinId === 'generic' && JET_CATEGORIES.has(ui.plan?.aircraft?.category)) return 'mcp';
  return 'native';
}

const na = () => flash('NOT AVAILABLE');
const display = (label, value) => ({ type: 'display', label, value });

// LVL CHG / FLCH: climb or descend to the selected altitude at the selected speed.
function lvlChg() {
  if (!ui.telemetry) return flash('NO TRACKING DATA');
  ap.vertical = 'ALT';
  ap.speedMode = 'SEL';
  if (!ap.autothrottle) return toggleAt();
  return render();
}
const altDiff = () => (typeof ui.telemetry?.altFt === 'number' ? Math.abs(ui.telemetry.altFt - ap.selected.altFt) : 0);

/** Boeing 737/747/777-style mode control panel, one control per named slot. */
function mcpControls() {
  const s = ap.selected;
  const managedSpeed = ap.speedMode === 'MANAGED' && ui.guidance?.speedKt;
  const course = ui.guidance?.lnav ? pad3(ui.guidance.lnav.desiredTrackDeg) : '---';
  return {
    courseL: display('COURSE', course),
    courseR: display('COURSE', course),
    at: button('A/T ARM', ap.autothrottle, toggleAt, 'switch'),
    n1: button('N1', false, na),
    speed: button('SPEED', ap.autothrottle && ap.speedMode === 'SEL', () => { ap.speedMode = 'SEL'; if (!ap.autothrottle) toggleAt(); else render(); }),
    lvlchg: button('LVL CHG', ap.vertical === 'ALT' && altDiff() > 300, lvlChg),
    ias: knob({ label: 'IAS/MACH', value: managedSpeed || s.speedKt, raw: () => s.speedKt, step: 1, bigStep: 10, set: (v) => (s.speedKt = Math.max(40, Math.min(600, v))) }),
    co: button('C/O', false, na, 'round'),
    spdIntv: button('SPD INTV', false, na, 'round'),
    vnav: button('V NAV', ap.vertical === 'VNAV', () => setVertical('VNAV')),
    lnav: button('L NAV', ap.lateral === 'LNAV', () => setLateral('LNAV')),
    vorloc: button('VOR LOC', false, na),
    app: button('APP', false, na),
    hdgsel: button('HDG SEL', ap.lateral === 'HDG', () => setLateral('HDG')),
    hdg: knob({ label: 'HEADING', value: pad3(s.headingDeg % 360 || 360), step: 1, bigStep: 10, set: (v) => (s.headingDeg = wrapHdg(v)), raw: () => s.headingDeg }),
    alt: knob({ label: 'ALTITUDE', value: s.altFt, step: 100, bigStep: 1000, set: (v) => (s.altFt = clampAlt(v)) }),
    altIntv: button('ALT INTV', false, na, 'round'),
    althld: button('ALT HLD', ap.vertical === 'ALT' && altDiff() <= 300, altHold),
    vsbtn: button('V/S', ap.vertical === 'VS', () => setVertical('VS')),
    vs: knob({ label: 'VERT SPEED', value: `${s.vsFpm > 0 ? '+' : ''}${s.vsFpm}`, step: 100, bigStep: 500, set: (v) => (s.vsFpm = Math.max(-6000, Math.min(6000, v))), raw: () => s.vsFpm }),
    cmdA: button('CMD', ap.engaged, toggleAp),
    cmdB: button('CMD', false, toggleAp),
    cwsA: button('CWS', false, na),
    cwsB: button('CWS', false, na),
    disengage: button('DISENGAGE', false, () => { if (ap.engaged) toggleAp(); }, 'disengage'),
    fdL: button('F/D', ui.fd !== false, () => { ui.fd = ui.fd === false; render(); }, 'switch'),
    fdR: button('F/D', ui.fd !== false, () => { ui.fd = ui.fd === false; render(); }, 'switch'),
  };
}

/** Embraer E-Jet guidance panel. */
function gpControls() {
  const k = fcpControls();
  const course = ui.guidance?.lnav ? pad3(ui.guidance.lnav.desiredTrackDeg) : '---';
  const decor = (label) => button(label, false, na);
  return {
    ...k,
    hdg: { ...k.hdg, label: 'HDG SEL', pushLabel: 'SYNC', push: () => { if (typeof ui.telemetry?.headingDeg === 'number') ap.selected.headingDeg = Math.round(ui.telemetry.headingDeg) || 360; } },
    ias: { ...k.ias, label: 'SPEED' },
    alt: { ...k.alt, label: 'ALT SEL' },
    crs: knob({ label: 'CRS', value: course, step: 1, bigStep: 10, set: () => {}, raw: () => 0 }),
    fd: button('FD', ui.fd !== false, () => { ui.fd = ui.fd === false; render(); }, 'switch'),
    src: decor('SRC'), bank: decor('BANK'),
    hsi: decor('HSI'), wx: decor('WX'), fms: decor('FMS'), prev: decor('PREV'), vl: decor('V/L'), fpr: decor('FPR'), brg1: decor('BRG ○'), brg2: decor('BRG ◇'),
  };
}

/** A220 flight control panel (the centre of the glareshield). */
function fcpControls() {
  const s = ap.selected;
  const managedSpeed = ap.speedMode === 'MANAGED' && ui.guidance?.speedKt;
  return {
    ias: knob({ label: 'IAS', value: managedSpeed || s.speedKt, raw: () => s.speedKt, step: 1, bigStep: 10, set: (v) => (s.speedKt = Math.max(40, Math.min(600, v))) }),
    hdg: knob({ label: 'HDG', value: pad3(s.headingDeg % 360 || 360), step: 1, bigStep: 10, set: (v) => (s.headingDeg = wrapHdg(v)), raw: () => s.headingDeg }),
    alt: knob({ label: 'ALT FT', value: s.altFt, step: 100, bigStep: 1000, set: (v) => (s.altFt = clampAlt(v)) }),
    vs: knob({ label: 'VS', value: ap.vertical === 'VS' ? s.vsFpm : 0, step: 100, bigStep: 500, set: (v) => (s.vsFpm = Math.max(-6000, Math.min(6000, v))), raw: () => s.vsFpm }),
    ap: button('AP', ap.engaged, toggleAp),
    yd: button('YD', ap.engaged, () => {}),
    at: button('A/T', ap.autothrottle, toggleAt),
    spd: button('SPD', ap.autothrottle && ap.speedMode === 'SEL', () => { ap.speedMode = 'SEL'; if (!ap.autothrottle) toggleAt(); else render(); }),
    hdgBtn: button('HDG', ap.lateral === 'HDG', () => setLateral('HDG')),
    nav: button('NAV', ap.lateral === 'LNAV', () => setLateral('LNAV')),
    appr: button('APPR', false, na),
    vnav: button('VNAV', ap.vertical === 'VNAV', () => setVertical('VNAV')),
    flc: button('FLC', ap.vertical === 'ALT' && altDiff() > 300, lvlChg),
    altBtn: button('ALT', ap.vertical === 'ALT' && altDiff() <= 300, altHold),
    vsBtn: button('VS', ap.vertical === 'VS', () => setVertical('VS')),
    disc: button('AP DISC', false, () => { if (ap.engaged) toggleAp(); }, 'disc'),
  };
}

/** Airbus A320/330/340 flight control unit (the centre section). */
function fcuControls() {
  const s = ap.selected;
  const managedSpeed = ap.speedMode === 'MANAGED';
  const managedHdg = ap.lateral === 'LNAV';
  const managedAlt = ap.vertical === 'VNAV';
  return {
    spd: knob({ label: 'SPD', value: managedSpeed ? '---' : s.speedKt, managed: managedSpeed, raw: () => s.speedKt, step: 1, bigStep: 10, set: (v) => (s.speedKt = Math.max(40, Math.min(600, v))), push: () => { ap.speedMode = 'MANAGED'; }, pull: () => { ap.speedMode = 'SEL'; } }),
    hdg: knob({ label: 'HDG', value: managedHdg ? '---' : pad3(s.headingDeg % 360 || 360), managed: managedHdg, step: 1, bigStep: 10, set: (v) => (s.headingDeg = wrapHdg(v)), raw: () => s.headingDeg, push: () => setLateral('LNAV'), pull: () => { syncIfDashed(); setLateral('HDG'); } }),
    alt: knob({ label: 'ALT', value: String(s.altFt).padStart(5, '0'), step: 100, bigStep: 1000, set: (v) => (s.altFt = clampAlt(v)), raw: () => s.altFt, push: () => setVertical('VNAV'), pull: () => { ap.vertical = 'ALT'; ap.speedMode = 'SEL'; } }),
    vs: knob({ label: 'V/S', value: ap.vertical === 'VS' ? `${s.vsFpm > 0 ? '+' : s.vsFpm < 0 ? '-' : ''}${String(Math.abs(s.vsFpm)).padStart(4, '0')}` : '-----', step: 100, bigStep: 500, set: (v) => (s.vsFpm = Math.max(-6000, Math.min(6000, v))), raw: () => s.vsFpm, push: altHold, pull: () => setVertical('VS') }),
    modeSpd: display('SPD', managedSpeed ? 'MANAGED' : 'SELECTED'),
    loc: button('LOC', false, na),
    ap1: button('AP 1', ap.engaged, toggleAp),
    ap2: button('AP 2', false, toggleAp),
    athr: button('A/THR', ap.autothrottle, toggleAt),
    exped: button('EXPED', false, na),
    appr: button('APPR', false, na),
    hdgTrk: button('HDG TRK', false, na, 'round'),
    vsFpa: button('V/S FPA', false, na, 'round'),
    spdMach: button('SPD MACH', false, na, 'round'),
    metric: button('METRIC ALT', false, na, 'round'),
    managedAlt: display('ALT', managedAlt ? 'MANAGED' : 'SELECTED'),
    fd: button('FD', ui.fd !== false, () => { ui.fd = ui.fd === false; render(); }, 'round'),
    ils: button('LS', false, na, 'round'),
  };
}

function panelFor(skinId) {
  const style = panelStyle(skinId);
  if (style === 'mcp') return [{ type: 'cockpit', style, controls: mcpControls() }];
  if (style === 'gp') return [{ type: 'cockpit', style, controls: gpControls() }];
  if (style === 'fcp') return [{ type: 'cockpit', style, controls: fcpControls() }];
  if (style === 'fcu' || style === 'fcu350') return [{ type: 'cockpit', style, controls: fcuControls() }];
  const s = ap.selected;
  // While managed, non-Airbus speed windows show the FMS target speed.
  const managedSpeed = ap.speedMode === 'MANAGED' && ui.guidance?.speedKt;
  const spdKnob = (extra = {}) => knob({ label: 'SPD', value: managedSpeed || s.speedKt, raw: () => s.speedKt, step: 1, bigStep: 10, set: (v) => (s.speedKt = Math.max(40, Math.min(600, v))), ...extra });
  const hdgKnob = (extra = {}) => knob({ label: 'HDG', value: pad3(s.headingDeg % 360 || 360), step: 1, bigStep: 10, set: (v) => (s.headingDeg = wrapHdg(v)), raw: () => s.headingDeg, ...extra });
  const altKnob = (extra = {}) => knob({ label: 'ALT', value: s.altFt, step: 100, bigStep: 1000, set: (v) => (s.altFt = clampAlt(v)), ...extra });
  const vsKnob = (extra = {}) => knob({ label: 'V/S', value: `${s.vsFpm > 0 ? '+' : ''}${s.vsFpm}`, step: 100, bigStep: 500, set: (v) => (s.vsFpm = Math.max(-6000, Math.min(6000, v))), raw: () => s.vsFpm, ...extra });

  if (skinId === 'airbus' || skinId === 'a350') {
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
  if (skinId === 'boeing' || skinId === 'boeing787') {
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
    { type: 'group', items: skinId === 'generic'
      ? [button('AP', ap.engaged, toggleAp), button('A/T', ap.autothrottle, toggleAt)]
      : [button('AP', ap.engaged, toggleAp), button('YD', ap.engaged, () => {}), button('A/T', ap.autothrottle, toggleAt)] },
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
  if (skinId === 'airbus' || skinId === 'a350') {
    return [
      ap.autothrottle ? 'SPEED' : '',
      ap.vertical === 'VNAV' ? managedVert : ap.vertical === 'VS' ? vsText : 'ALT',
      ap.lateral === 'LNAV' ? 'NAV' : 'HDG',
      [ap.engaged ? 'AP1' : '', ap.autothrottle ? 'A/THR' : ''].filter(Boolean).join(' '),
    ];
  }
  const pitch = ap.vertical === 'VNAV' ? (vnavPhase === 'CRZ' ? 'VNAV PTH' : 'VNAV SPD') : ap.vertical === 'VS' ? 'V/S' : 'ALT HOLD';
  if (skinId === 'boeing' || skinId === 'boeing787') {
    return [ap.autothrottle ? (ap.vertical === 'VNAV' && vnavPhase === 'CLB' ? 'N1' : 'MCP SPD') : '', ap.lateral === 'LNAV' ? 'LNAV' : 'HDG SEL', pitch, ap.engaged ? 'CMD' : ''];
  }
  const apText = skinId === 'generic' ? (ap.engaged ? 'AP' : '') : [ap.engaged ? 'AP' : '', ap.engaged ? 'YD' : ''].filter(Boolean).join(' ');
  return [ap.autothrottle ? 'SPD' : '', ap.lateral === 'LNAV' ? 'LNAV' : 'HDG', ap.vertical === 'VNAV' ? 'VPTH' : ap.vertical === 'VS' ? 'VS' : 'ALT', apText];
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
    if (item.type === 'cockpit') {
      return { type: 'cockpit', style: item.style, controls: Object.fromEntries(Object.entries(item.controls).map(([name, c]) => [name, serialize(c)])) };
    }
    if (item.type === 'display') return { type: 'display', label: item.label, value: String(item.value) };
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
      style: s.screenStyle || 'mcdu',
      page: ui.page === 'dir' ? 'legs' : ui.page,
      phase: ui.guidance?.phase || null,
      selected: ui.selectedField || null,
      title: page.title,
      titleRight: page.titleRight || '',
      rows: page.rows,
      scratch: ui.message
        ? { text: ui.message, cls: ui.message === 'LOADING...' ? 'white' : 'amber' }
        : { text: ui.scratch, cls: '' },
    },
    // Each key: its label, which block it sits in (main rows, or the small
    // block above the number pad), and how it's drawn. Indexes are the
    // skin's key indexes, which input messages refer back to.
    fkeys: s.keys.map(([label, action, opts = '']) => ({
      label,
      exec: action === 'exec',
      group: ['nav', 'subtab', 'tab', 'bottom'].find((g) => opts.split(' ').includes(g)) || 'main',
      target: action || null,
      scope: opts.includes('perf') ? 'perf' : null,
      kind: action === 'knob' ? 'knob' : action === 'blank' ? 'blank' : label ? 'key' : 'spacer',
      cls: opts.split(' ').filter((o) => !['nav', 'tab', 'subtab', 'bottom', 'perf'].includes(o)).join(' '),
    })),
    fkeyCols: s.keyCols || 6,
    alpha: s.alpha || DEFAULT_ALPHA,
    alphaCols: s.alphaCols || null,
    numeric: s.numeric || DEFAULT_NUMERIC,
    numericCols: s.numericCols || 3,
    annunciators: s.annunciators || [],
    execLit: Boolean(ui.pending),
    panel: buildPanel(skinId),
    fma: { cols: fmaColumns(panelStyle(skinId) === 'mcp' ? 'boeing' : skinId), warn: ap.disconnectReason || '' },
    status: buildStatus(),
  };
}

function render() {
  const vm = buildView();
  FmsView.render(vm);
  api?.publishFmsView?.(vm);
}

const KEYPAD = new Set('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789./'.split('').concat(['SP', 'DEL', 'CLR', '+/-', 'OVFY', '←', 'SPACE', 'NOTE PAD', 'ENT', 'CLR DEL', 'ENTER']));

/** The one entry point for every cockpit input - local clicks and remotes. */
function handleInput(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'lsk' && /^[LR][1-6]$/.test(msg.id)) return onLsk(msg.id);
  if (msg.type === 'clear-info') return onFunctionKey('clrinfo');
  if (msg.type === 'key' && KEYPAD.has(msg.ch)) return onKey(msg.ch);
  if (msg.type === 'fkey' && Number.isInteger(msg.index)) {
    const key = skin().keys[msg.index];
    if (key && (key[0] || key[1] === 'blank')) onFunctionKey(key[1]);
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
  if (ap.engaged || ap.autothrottle) {
    ui.flightLog.push(Autopilot.logRow(sample, out));
    if (ui.flightLog.length > 4000) ui.flightLog.shift();
  }
  if (ui.calib) await stepCalibration(sample);
  if (out.disconnected) {
    api?.autopilotReleaseAll();
    api?.autopilotRecenter(null);
    updatePassthrough();
  }
  await sendCommands(out.commands);
  render();
}

// ---------------------------------------------------------------- tuning

const TUNING_LABELS = {
  turnRatePerDegErr: 'Turn rate per degree of heading error',
  maxTurnRateDegS: 'Max turn rate (deg/s)',
  rollMsPerDegS: 'Bank tap per deg/s (ms)',
  vsPerFtErr: 'Vertical speed per foot of altitude error',
  pitchMsPerFpm: 'Pitch tap per fpm (ms)',
  throttleMsPerKt: 'Throttle tap per kt (ms)',
  decelBoost: 'Extra throttle-back when too fast (x)',
};

function buildTuningEditor() {
  const box = $('tuning');
  if (!box) return;
  box.innerHTML = '';
  for (const [key, label] of Object.entries(TUNING_LABELS)) {
    const [lo, hi] = Autopilot.TUNABLE[key];
    const line = document.createElement('label');
    line.className = 'field';
    line.textContent = label;
    const input = document.createElement('input');
    input.type = 'number';
    input.id = `tune-${key}`;
    input.min = lo; input.max = hi; input.step = 'any';
    input.value = ap.tuning[key];
    input.addEventListener('change', () => {
      const changed = Autopilot.setTuning(ap, { [key]: input.value });
      if (!changed.length) { input.value = ap.tuning[key]; $('cal-msg').textContent = `${label}: use a value from ${lo} to ${hi}`; return; }
      settings.tuning[key] = ap.tuning[key];
      saveSettings();
    });
    line.append(input);
    box.append(line);
  }
}

const CAL_PULSE = { roll: { ms: 300, label: 'bank' }, pitch: { ms: 250, label: 'pitch' }, throttle: { ms: 450, label: 'throttle' } };

function startCalibration(axis) {
  const msg = (t) => { $('cal-msg').textContent = t; };
  if (!settings.live) return msg('Switch to LIVE first (top right), then click into PTFS.');
  if (ap.engaged || ap.autothrottle) return msg('Turn the autopilot and A/T off first.');
  if (!ui.telemetry) return msg('No tracking data yet.');
  if (axis !== 'throttle' && settings.steering === 'mouse' && !settings.mouseCenter) return msg('Capture the mouse center first.');
  ui.calib = { axis, phase: 'before', before: [], after: [], startedAt: Date.now(), pulseAt: null };
  msg(`Calibrating ${CAL_PULSE[axis].label}: keep the aircraft straight and level for about 10 s...`);
}

async function stepCalibration(sample) {
  const c = ui.calib;
  const msg = (t) => { $('cal-msg').textContent = t; };
  if (c.phase === 'before') {
    c.before.push(sample);
    if (c.before.length >= 4 && Date.now() - c.startedAt >= 8000) {
      c.phase = 'after';
      c.pulseAt = Date.now();
      msg(`Tapping ${CAL_PULSE[c.axis].label} for ${CAL_PULSE[c.axis].ms} ms - watch the aircraft...`);
      await sendCommands([{ axis: c.axis, direction: 1, ms: CAL_PULSE[c.axis].ms }]);
    }
  } else if (c.phase === 'after') {
    c.after.push(sample);
    if (c.after.length >= 5 && Date.now() - c.pulseAt >= 12000) {
      const r = Autopilot.measureResponse(c.axis, c.before, c.after, CAL_PULSE[c.axis].ms, 1);
      ui.calib = null;
      if (!r) return msg('Not enough response to measure - make sure the autopilot is off, you are straight and level, and the input reached the game. Try again.');
      const previous = ap.tuning[r.key];
      Autopilot.setTuning(ap, { [r.key]: r.value });
      settings.tuning[r.key] = ap.tuning[r.key];
      saveSettings();
      buildTuningEditor();
      msg(`${TUNING_LABELS[r.key]}: ${previous} -> ${ap.tuning[r.key]} (measured). Saved. Re-level the aircraft; you can edit the number if it feels off.`);
    }
  }
}

for (const axis of ['roll', 'pitch', 'throttle']) $(`cal-${axis}`).addEventListener('click', () => startCalibration(axis));
$('tune-reset').addEventListener('click', () => {
  settings.tuning = {};
  Object.assign(ap.tuning, Autopilot.DEFAULT_TUNING);
  saveSettings();
  buildTuningEditor();
  $('cal-msg').textContent = 'Back to the default gains';
});
$('log-download').addEventListener('click', () => {
  if (!ui.flightLog.length) return ($('cal-msg').textContent = 'Nothing logged yet - the log fills while the autopilot or A/T is on.');
  const url = URL.createObjectURL(new Blob([Autopilot.toCsv(ui.flightLog)], { type: 'text/csv' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `autopilot-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv` });
  a.click();
  URL.revokeObjectURL(url);
});
$('log-clear').addEventListener('click', () => { ui.flightLog = []; $('cal-msg').textContent = 'Log cleared'; });

// ---------------------------------------------------------------- settings UI

async function loadSettings() {
  const saved = (await api?.loadFmsSettings?.()) || {};
  Object.assign(settings, saved, { keymap: { ...DEFAULT_KEYMAP, ...(saved.keymap || {}) }, live: false });
  Autopilot.setTuning(ap, settings.tuning);
  buildTuningEditor();
  $('planner-url').value = settings.plannerUrl || '';
  $('skin-select').value = settings.skin || 'auto';
  $('panel-select').value = settings.panel || 'auto';
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
$('panel-select').addEventListener('change', () => {
  settings.panel = $('panel-select').value;
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
