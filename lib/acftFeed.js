// Live aircraft positions from the ATC24 data feed: the game's own numbers
// (position in studs, heading, altitude, speed) for every aircraft, instead of
// reading them off the screen. The autopilot flies much better on this - true
// heading every second rather than OCR every few - and it identifies your
// aircraft by callsign.
//
// The idea (and the message shapes handled below) follow 24Flight Desktop's
// feed handling (https://github.com/24FlightOrg/24Flight-Desktop, MIT - see
// THIRD_PARTY.md). Both the official ATC24 feed ({t: 'ACFT_DATA', d: {...}})
// and 24Flight's relay ({type: 'acft', payload: {...}}) are understood; either
// way the aircraft are an object keyed by callsign:
//   { "N42Y": { position: {x, y}, heading, altitude, speed, groundSpeed, isOnGround, aircraftType, playerName } }

const DEFAULT_URL = 'wss://24data.ptfs.app/wss';
const RECONNECT_MS = 5000;

/** Parses one message; returns the {callsign: aircraft} object, or null if it isn't an aircraft update. */
function parseMessage(text) {
  let msg;
  try { msg = typeof text === 'string' ? JSON.parse(text) : text; } catch { return null; }
  if (!msg || typeof msg !== 'object') return null;
  const kind = String(msg.t || msg.type || '').toLowerCase();
  const body = msg.d ?? msg.payload;
  if (!['acft_data', 'acft', 'acft-data'].includes(kind)) return null;
  return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
}

const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Finds your aircraft: the callsign as the key, else as the player name. */
function pickAircraft(aircraft, callsign) {
  const want = norm(callsign);
  if (!want) return null;
  for (const [key, a] of Object.entries(aircraft)) if (norm(key) === want) return { callsign: key, ...a };
  for (const [key, a] of Object.entries(aircraft)) if (norm(a?.playerName) === want) return { callsign: key, ...a };
  return null;
}

/** One aircraft entry -> a sample, or null when it has no usable position. */
function toSample(a, atMs = Date.now()) {
  const x = Number(a?.position?.x), y = Number(a?.position?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const num = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
  const heading = num(a.heading);
  const altitude = num(a.altitude);
  const speed = num(a.speed);
  return {
    studX: x, studY: y,
    headingDeg: heading === null ? null : ((Math.round(heading) % 360) + 360) % 360,
    altFt: altitude === null ? null : Math.round(altitude),
    speedKt: speed === null ? null : Math.round(speed),
    groundSpeedKt: num(a.groundSpeed),
    onGround: Boolean(a.isOnGround),
    aircraftType: a.aircraftType || null,
    callsign: a.callsign || null,
    atMs,
  };
}

/**
 * Keeps a WebSocket open to the feed and calls onSample for each update of
 * `callsign`. `WebSocketImpl` is the `ws` package in the app; tests pass a fake.
 */
function createFeed({ url = DEFAULT_URL, callsign = '', WebSocketImpl, onSample, onStatus = () => {}, now = Date.now }) {
  let ws = null;
  let timer = null;
  let stopped = true;
  let wanted = callsign;
  let seenAny = false;

  function status(state, detail = '') { onStatus({ state, detail }); }

  function connect() {
    if (stopped) return;
    try {
      ws = new WebSocketImpl(url);
    } catch (err) {
      status('error', err.message);
      return schedule();
    }
    ws.on('open', () => status(wanted ? 'waiting' : 'no-callsign', wanted ? `connected - waiting for ${wanted}` : 'connected - set your callsign'));
    ws.on('message', (data) => {
      const aircraft = parseMessage(data.toString());
      if (!aircraft) return;
      const mine = pickAircraft(aircraft, wanted);
      if (!mine) { if (seenAny) { seenAny = false; status('waiting', `${wanted} is not in the feed`); } return; }
      const sample = toSample(mine, now());
      if (!sample) return;
      if (!seenAny) { seenAny = true; status('tracking', `tracking ${mine.callsign}`); }
      onSample(sample);
    });
    ws.on('close', () => { status('closed', 'disconnected - retrying'); schedule(); });
    ws.on('error', (err) => status('error', err.message));
  }

  function schedule() {
    if (stopped || timer) return;
    timer = setTimeout(() => { timer = null; connect(); }, RECONNECT_MS);
    timer.unref?.();
  }

  return {
    start() { if (!stopped) return; stopped = false; seenAny = false; connect(); },
    stop() { stopped = true; clearTimeout(timer); timer = null; try { ws?.close(); } catch { /* already closed */ } ws = null; status('stopped'); },
    setCallsign(c) { wanted = c; seenAny = false; },
  };
}

/**
 * Same job as createFeed, but reads AutoATC's own monitor (GET /api/public/v1/traffic) once a
 * second - the positions every pilot's companion reports, on the world grid already.
 */
function createMonitorFeed({ url, callsign = '', fetchImpl = globalThis.fetch, onSample, onStatus = () => {}, intervalMs = 1000, now = Date.now }) {
  let timer = null, stopped = true, want = norm(callsign), lastState = null;
  const base = String(url || '').replace(/\/+$/, '');
  const status = (state, detail) => { if (state !== lastState) { lastState = state; onStatus({ state, detail, message: detail ? `${state} - ${detail}` : state }); } };
  async function poll() {
    if (stopped) return;
    try {
      if (!want) { status('no-callsign', 'enter your callsign'); }
      else {
        const res = await fetchImpl(`${base}/api/public/v1/traffic`);
        if (!res.ok) throw new Error(`monitor answered ${res.status}`);
        const body = await res.json();
        const mine = (body.aircraft || []).find((a) => norm(a.callsign) === want);
        const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
        if (!mine || num(mine.xNm) === null || num(mine.yNm) === null) status('waiting', `no position report for ${callsign} yet - is your tracking on?`);
        else {
          status('tracking', `tracking ${mine.callsign}`);
          // Stale reports are still handed over; the autopilot's own staleness check (atMs) decides.
          onSample({ xNm: mine.xNm, yNm: mine.yNm, headingDeg: num(mine.headingDeg), altFt: num(mine.altitudeFt), speedKt: num(mine.speedKt),
            groundSpeedKt: null, onGround: false, aircraftType: mine.aircraftType || null, callsign: mine.callsign, atMs: now() - (num(mine.reportAgeMs) || 0) });
        }
      }
    } catch (err) { status('error', err.message); }
    if (!stopped) { timer = setTimeout(poll, intervalMs); timer.unref?.(); }
  }
  return {
    start() { if (!stopped) return; stopped = false; lastState = null; poll(); },
    stop() { stopped = true; clearTimeout(timer); timer = null; status('stopped'); },
    setCallsign(c) { want = norm(c); },
  };
}

module.exports = {
  createMonitorFeed, DEFAULT_URL, parseMessage, pickAircraft, toSample, createFeed };
