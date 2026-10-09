// Pushes live aircraft positions to the flightradar365 tracking endpoint
// (POST <FR365_URL>, header x-bot-key, body { aircraft: [...], replace: true }).
//
// Off unless FR365_BOT_KEY is set. Only whitelisted fields leave this server:
// callsign, x/y, altitude, ground_speed, heading - no pilot names, squawk,
// transcripts or flight plans. x/y are the same world-grid nautical miles the
// public radar API serves (x east, y south, origin at the north-west corner).
//
//   FR365_BOT_KEY      required - the key their site issued (keep it in the host's env, never in git)
//   FR365_URL          default https://flightradar365.lovable.app/api/public/track
//   FR365_INTERVAL_MS  default 3000, clamped to 1000-5000 (their docs ask for every 1-5 s)

const { toPublicAircraft } = require('./publicApi');

const DEFAULT_URL = 'https://flightradar365.lovable.app/api/public/track';
const MAX_AIRCRAFT = 500; // their per-push limit

function buildPayload(rows) {
  const seen = new Set();
  const aircraft = [];
  for (const row of rows) {
    const a = toPublicAircraft(row);
    if (!a.callsign || a.xNm === null || a.yNm === null || seen.has(a.callsign)) continue; // callsign is their match key
    seen.add(a.callsign);
    const out = { callsign: a.callsign, x: a.xNm, y: a.yNm };
    if (a.altitudeFt !== null) out.altitude = a.altitudeFt;
    if (a.speedKt !== null) out.ground_speed = a.speedKt;
    if (a.headingDeg !== null) out.heading = a.headingDeg;
    aircraft.push(out);
    if (aircraft.length >= MAX_AIRCRAFT) break;
  }
  // replace:true = "this is the whole list", so planes that left are removed on their side too
  return { aircraft, replace: true };
}

function createPusher({ getPositions, key, url = DEFAULT_URL, intervalMs = 3000, fetchImpl = fetch, log = console }) {
  let timer = null;
  let lastError = '';

  async function tick() {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bot-key': key },
        body: JSON.stringify(buildPayload(getPositions())),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      lastError = '';
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      if (msg !== lastError) log.warn(`[flightradar365] push failed: ${msg}`); // once per distinct error, not every tick
      lastError = msg;
    }
  }

  return {
    tick,
    start() { if (!timer) { timer = setInterval(tick, intervalMs); timer.unref?.(); tick(); } },
    stop() { clearInterval(timer); timer = null; },
  };
}

/** Starts the pusher if FR365_BOT_KEY is set; returns it (or null). */
function startFromEnv(getPositions, env = process.env) {
  if (!env.FR365_BOT_KEY) return null;
  const ms = Math.min(5000, Math.max(1000, Number(env.FR365_INTERVAL_MS) || 3000));
  const pusher = createPusher({ getPositions, key: env.FR365_BOT_KEY, url: env.FR365_URL || DEFAULT_URL, intervalMs: ms });
  pusher.start();
  console.log(`[flightradar365] pushing positions every ${ms} ms`);
  return pusher;
}

module.exports = { buildPayload, createPusher, startFromEnv };
