// Event flight plans (/fpl): pilots file callsign, aircraft type, departure and arrival; the route is always radar
// vectors and each plan gets its own squawk code. The AI controllers read them (src/flightplans/store.js) to match a
// pilot's callsign and clear them "via radar vectors". Kept in memory and in a small JSON file, so a restart keeps
// them (a redeploy without a volume does not). Replaces the flightradar365 flight plans while that API is down.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const KEEP_MS = 12 * 60 * 60 * 1000; // a plan expires 12 h after it was filed or last updated
const MAX_PLANS = 1000;
const ROUTE = 'RADAR VECTORS';

// Suggested in the form; any 4-letter ICAO code is accepted.
const AIRPORTS = [
  ['IRFD', 'Greater Rockford'], ['IMLR', 'Mellor'], ['IKFL', 'Keflavik'], ['ITKO', 'Tokyo'], ['ILAR', 'Larnaca'],
  ['IPAP', 'Paphos'], ['ISAU', 'Sauthemptona'], ['IBTH', 'Saint Barthélemy'], ['IPPH', 'Perth'], ['IGAR', 'Garry'],
  ['IBLT', 'Boltic'], ['IDCS', 'Saba'], ['IBRD', 'Bird Island'], ['ILKL', 'Lukla'], ['ITEY', 'Pingyeri'],
  ['IIAB', 'McConnell'], ['IBAR', 'Barra'], ['IHEN', 'Henstridge'], ['IZOL', 'Izolirani'], ['IJAF', 'Al Najaf'],
  ['ISCM', 'Scrampton'], ['ISKP', 'Skopelos'], ['IGRV', 'Grindavik'], ['IUFO', 'UFO Base'],
];

// Squawks pilots must never be given: emergencies, VFR conspicuity and the like.
const RESERVED_SQUAWKS = new Set(['7500', '7600', '7700', '1200', '2000', '7000', '0000', '1000']);

function clean(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Validates a filing; returns {plan} or {error}. */
function validate(body) {
  const callsign = clean(body && body.callsign, 12).toUpperCase().replace(/[\s-]/g, '');
  const aircraft = clean(body && body.aircraft, 30).toUpperCase();
  const dep = clean(body && body.dep, 20).toUpperCase();
  const arr = clean(body && body.arr, 20).toUpperCase();
  if (!/^[A-Z0-9]{2,10}$/.test(callsign)) return { error: 'Callsign: letters and numbers only, like DAL123 or N42Y.' };
  if (!/^[A-Z0-9][A-Z0-9 \-/]{1,29}$/.test(aircraft)) return { error: 'Aircraft type: like A320, B738 or Cessna 172.' };
  if (!/^[A-Z]{4}$/.test(dep)) return { error: 'Departure: a 4-letter airport code like IRFD.' };
  if (!/^[A-Z]{4}$/.test(arr)) return { error: 'Arrival: a 4-letter airport code like ITKO.' };
  return { plan: { callsign, aircraft, dep, arr } };
}

function createFlightPlans({ file = null, now = () => Date.now() } = {}) {
  const plans = new Map(); // callsign -> {callsign, aircraft, dep, arr, route, squawk, filedAt, updatedAt, token}
  if (file) {
    try {
      for (const p of JSON.parse(fs.readFileSync(file, 'utf8'))) if (p && p.callsign) plans.set(p.callsign, p);
    } catch { /* first run */ }
  }
  function save() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify([...plans.values()]));
      fs.renameSync(`${file}.tmp`, file);
    } catch { /* keep going in memory */ }
  }
  function prune() {
    const cutoff = now() - KEEP_MS;
    let changed = false;
    for (const [k, p] of plans) if (Date.parse(p.updatedAt) < cutoff) { plans.delete(k); changed = true; }
    return changed;
  }
  function newSquawk() {
    const used = new Set([...plans.values()].map((p) => p.squawk));
    for (let i = 0; i < 500; i++) {
      // octal digits only, like a real transponder; avoid 1xxx/7xxx blocks and reserved codes
      const code = String(2 + crypto.randomInt(5)) + [0, 0, 0].map(() => crypto.randomInt(8)).join('');
      if (!RESERVED_SQUAWKS.has(code) && !used.has(code)) return code;
    }
    return '4' + String(crypto.randomInt(512)).padStart(3, '0').replace(/[89]/g, '0');
  }
  /** Public view (no edit tokens), newest first. */
  function list() {
    if (prune()) save();
    return [...plans.values()]
      .map(({ token, ...p }) => p) // eslint-disable-line no-unused-vars
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }
  /**
   * Files or updates a plan. Updating someone else's callsign needs the token they got when filing (kept in their
   * browser), so nobody can overwrite another pilot's plan.
   */
  function file_(body, token) {
    const v = validate(body);
    if (v.error) return { status: 400, error: v.error };
    prune();
    const existing = plans.get(v.plan.callsign);
    if (existing && existing.token !== token) {
      return { status: 409, error: `${v.plan.callsign} already has a flight plan. Use a different callsign, or file from the same browser to change it.` };
    }
    if (!existing && plans.size >= MAX_PLANS) return { status: 503, error: 'Too many flight plans right now. Try again later.' };
    const at = new Date(now()).toISOString();
    const plan = {
      ...v.plan,
      route: ROUTE,
      squawk: existing ? existing.squawk : newSquawk(),
      filedAt: existing ? existing.filedAt : at,
      updatedAt: at,
      token: existing ? existing.token : crypto.randomBytes(16).toString('hex'),
    };
    plans.set(plan.callsign, plan);
    save();
    const { token: t, ...pub } = plan;
    return { status: existing ? 200 : 201, plan: pub, token: t };
  }
  function cancel(callsign, token) {
    const p = plans.get(String(callsign || '').toUpperCase());
    if (!p) return { status: 404, error: 'No flight plan for that callsign.' };
    if (p.token !== token) return { status: 403, error: 'You can only cancel a flight plan from the browser that filed it.' };
    plans.delete(p.callsign);
    save();
    return { status: 204 };
  }
  return { list, file: file_, cancel, size: () => plans.size };
}

// ---- HTTP -------------------------------------------------------------------------------------------------------
function createFlightPlanRouter(store, { limitPerMinute = 20 } = {}) {
  const router = express.Router();
  const hits = new Map(); // ip -> [timestamps]
  function rateLimited(req) {
    const ip = req.ip || req.socket.remoteAddress || '?';
    const recent = (hits.get(ip) || []).filter((t) => Date.now() - t < 60000);
    recent.push(Date.now());
    hits.set(ip, recent);
    if (hits.size > 5000) hits.clear();
    return recent.length > limitPerMinute;
  }
  const token = (req) => String(req.get('x-plan-token') || '');

  router.get('/', (req, res) => res.json({ plans: store.list(), airports: AIRPORTS.map(([icao, name]) => ({ icao, name })) }));
  router.post('/', (req, res) => {
    if (rateLimited(req)) return res.status(429).json({ error: 'Too many requests. Wait a minute.' });
    const r = store.file(req.body || {}, token(req));
    if (r.error) return res.status(r.status).json({ error: r.error });
    res.status(r.status).json({ plan: r.plan, token: r.token });
  });
  router.delete('/:callsign', (req, res) => {
    if (rateLimited(req)) return res.status(429).json({ error: 'Too many requests. Wait a minute.' });
    const r = store.cancel(req.params.callsign, token(req));
    if (r.error) return res.status(r.status).json({ error: r.error });
    res.status(204).end();
  });
  return router;
}

module.exports = { createFlightPlans, createFlightPlanRouter, validate, AIRPORTS, ROUTE };
