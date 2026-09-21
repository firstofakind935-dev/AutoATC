require('dotenv').config();

const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const INGEST_API_KEY = process.env.INGEST_API_KEY || null;
const DASHBOARD_USERNAME = process.env.DASHBOARD_USERNAME || null;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || null;
// A read-only credential for external consumers (e.g. a companion website)
// that should be able to read live positions but must never be able to do
// anything INGEST_API_KEY can (post fake logs/positions, send CPDLC
// messages, overwrite flight strips) - a leaked read key is a nuisance, a
// leaked ingest key is a real problem. Note /api/dashboard/positions below
// already serves this same data with NO auth at all - only bother handing
// out this key if you want something less discoverable/more revocable
// than that open URL.
const EXTERNAL_API_KEY = process.env.EXTERNAL_API_KEY || null;

const MAX_LOGS = 5000;
const OFFLINE_THRESHOLD_MS = 90_000; // matches the bot fleet's heartbeat interval (60s) with margin
const POSITION_STALE_MS = 30_000; // a position report older than this is dropped from /api/positions - stale beats wrong
const CPDLC_MAX_PER_CALLSIGN = 20; // ring buffer per callsign - old ones age out via CPDLC_TTL_MS below anyway
const CPDLC_TTL_MS = 10 * 60_000; // a "contact me"/PDC message nobody's polled for in 10 minutes isn't worth surfacing late
const FLIGHT_STRIP_TTL_MS = 3 * 60 * 60_000; // hygiene only, not a "staleness" concept - a strip can sit unchanged for a long enroute leg

if (!INGEST_API_KEY) {
  console.warn(
    '[monitor] WARNING: INGEST_API_KEY is not set. The ingest endpoint is open - anyone who ' +
      'finds this URL can post fake bot logs. Set INGEST_API_KEY in production.'
  );
}
if (!DASHBOARD_USERNAME || !DASHBOARD_PASSWORD) {
  console.warn(
    '[monitor] WARNING: DASHBOARD_USERNAME/DASHBOARD_PASSWORD are not set. The dashboard is ' +
      'open to anyone who finds this URL, including live pilot transcripts. Set both in production.'
  );
}
if (!EXTERNAL_API_KEY) {
  console.warn(
    '[monitor] NOTE: EXTERNAL_API_KEY is not set, so /api/external/positions is open to anyone ' +
      'who finds it (same as /api/dashboard/positions already is). Set EXTERNAL_API_KEY if you ' +
      'want that endpoint specifically to require a key.'
  );
}

const logs = []; // ring buffer, oldest first
const botStatus = new Map(); // bot name -> { lastSeen, lastLevel, lastMessage }
const positions = new Map(); // normalized callsign -> { callsign, aircraftType, speed, position, receivedAt }
const cpdlcMessages = new Map(); // normalized callsign -> array of messages, oldest first
const broadcastMessages = []; // fleet-wide announcements, oldest first - see POST /api/cpdlc/broadcast
let nextCpdlcId = 1; // shared across per-callsign and broadcast messages, so a single "since" cursor covers both
const flightStrips = new Map(); // normalized callsign -> latest strip snapshot (see src/atc/flightStrips.js)
// normalized callsign -> {callsign, discordUserId, guildId, linkedAt} - set
// by whichever bot handles the /fileflightplan command (see
// src/bot/BotManagerBot.js), since that's a Discord interaction and so
// already carries interaction.user.id. Bot Manager looks this up to know
// who to move when a companion-app pilot tunes a new frequency.
const pilotLinks = new Map();
// Pending frequency-tune requests from the companion app, oldest first -
// Bot Manager polls and drains this (see GET/DELETE /api/tune-requests
// below), same "post here, a bot polls and acts" shape as CPDLC.
const tuneRequests = [];
let nextTuneRequestId = 1;

function normalizeCallsign(raw) {
  return (raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function pushLog(entry) {
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.shift();
  botStatus.set(entry.bot, {
    lastSeen: entry.timestamp,
    lastLevel: entry.level,
    lastMessage: entry.message,
  });
}

function requireIngestAuth(req, res, next) {
  if (!INGEST_API_KEY) return next();
  const auth = req.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token !== INGEST_API_KEY) return res.status(401).json({ error: 'unauthorized' });
  next();
}

function requireExternalReadAuth(req, res, next) {
  if (!EXTERNAL_API_KEY) return next();
  const auth = req.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token !== EXTERNAL_API_KEY) return res.status(401).json({ error: 'unauthorized' });
  next();
}

function requireDashboardAuth(req, res, next) {
  if (!DASHBOARD_USERNAME || !DASHBOARD_PASSWORD) return next();
  const auth = req.get('authorization') || '';
  if (auth.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    const separatorIndex = decoded.indexOf(':');
    const user = decoded.slice(0, separatorIndex);
    const pass = decoded.slice(separatorIndex + 1);
    if (user === DASHBOARD_USERNAME && pass === DASHBOARD_PASSWORD) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="AutoATC Monitor"');
  res.status(401).send('Authentication required');
}

const app = express();
app.use(express.json({ limit: '256kb' }));

app.get('/health', (req, res) => res.status(200).send('ok'));

app.post('/api/ingest', requireIngestAuth, (req, res) => {
  const { bot, level, message } = req.body || {};
  if (!bot || typeof bot !== 'string') return res.status(400).json({ error: '"bot" is required' });
  if (!message || typeof message !== 'string') return res.status(400).json({ error: '"message" is required' });

  const entry = {
    bot,
    level: ['info', 'warn', 'error'].includes(level) ? level : 'info',
    message,
    timestamp: new Date().toISOString(),
  };
  pushLog(entry);
  broadcast(entry);
  res.status(204).end();
});

app.get('/api/logs', requireDashboardAuth, (req, res) => {
  const { bot, limit } = req.query;
  let results = logs;
  if (bot) results = results.filter((e) => e.bot === bot);
  const max = Math.min(Number(limit) || MAX_LOGS, MAX_LOGS);
  res.json(results.slice(-max));
});

app.get('/api/status', requireDashboardAuth, (req, res) => {
  const now = Date.now();
  const result = [...botStatus.entries()].map(([bot, info]) => ({
    bot,
    ...info,
    online: now - new Date(info.lastSeen).getTime() < OFFLINE_THRESHOLD_MS,
  }));
  result.sort((a, b) => a.bot.localeCompare(b.bot));
  res.json(result);
});

// Pushed by the screen-capture companion app running on each pilot's own
// machine (see companion/), not by the bot fleet. `position` is deliberately
// opaque here - the server just stores and re-serves whatever shape the
// companion app + bots have agreed on (e.g. distance/bearing from a named
// airport, or a raw estimate), since that shape is still being finalized
// against how the game's minimap actually behaves.
app.post('/api/position', requireIngestAuth, (req, res) => {
  const { callsign, aircraftType, speed, position } = req.body || {};
  if (!callsign || typeof callsign !== 'string') return res.status(400).json({ error: '"callsign" is required' });
  if (!position || typeof position !== 'object') return res.status(400).json({ error: '"position" is required' });

  const key = normalizeCallsign(callsign);
  if (!key) return res.status(400).json({ error: '"callsign" has no usable characters' });

  positions.set(key, {
    callsign,
    aircraftType: typeof aircraftType === 'string' ? aircraftType : null,
    speed: typeof speed === 'number' ? speed : null,
    position,
    receivedAt: Date.now(),
  });
  res.status(204).end();
});

// A bot-assigned radar vector (see flightStrips.js's clearance.assignedHeadingDeg
// comment) is LLM-produced JSON that a radar consuming /api/positions or
// /api/dashboard/positions below would draw directly - validate it here
// rather than trust it, since a stray string or out-of-range value would
// otherwise draw a garbage line instead of just... not drawing one.
function activeVectorFor(callsign) {
  const strip = flightStrips.get(normalizeCallsign(callsign));
  const heading = strip?.clearance?.assignedHeadingDeg;
  if (typeof heading !== 'number' || !Number.isFinite(heading) || heading < 0 || heading >= 360) return null;
  const reason = strip.clearance.vectorReason;
  return { assignedHeadingDeg: heading, vectorReason: typeof reason === 'string' ? reason : null };
}

function freshPositions() {
  const now = Date.now();
  return [...positions.values()]
    .filter((p) => now - p.receivedAt < POSITION_STALE_MS)
    .map(({ callsign, aircraftType, speed, position, receivedAt }) => ({
      callsign,
      aircraftType,
      speed,
      position,
      ageMs: now - receivedAt,
      ...activeVectorFor(callsign),
    }));
}

// Read by the bot fleet (Approach/Departure/Center) to ground vectoring in
// an actual reported position instead of guessing - same trust tier as
// ingest, since this is a server-to-server call, not a human dashboard view.
app.get('/api/positions', requireIngestAuth, (req, res) => {
  res.json(freshPositions());
});

// Same data, for a browser-facing radar to poll directly (no Bearer token
// required, unlike /api/positions above, which expects a server-to-server
// credential) - AutoATC's own web radar used to be the only consumer of
// this; that's been pulled out, but the route stays as its integration
// point for whatever radar replaces it. Deliberately not gated by
// requireDashboardAuth: live traffic position isn't worth protecting the
// way logs/pilot transcripts are.
app.get('/api/dashboard/positions', (req, res) => {
  res.json(freshPositions());
});

// Same data again, for an external consumer outside the bot fleet/dashboard
// (e.g. a companion website) that wants to pull live positions server-side
// without using the fully-public /api/dashboard/positions URL above. Gated
// by EXTERNAL_API_KEY - a separate credential from INGEST_API_KEY, since
// this is meant to be handed to a third party and should only ever grant
// read access, never the ability to post fake data through the ingest
// endpoints below.
app.get('/api/external/positions', requireExternalReadAuth, (req, res) => {
  res.json(freshPositions());
});

// Pushed by an ATC bot (see src/atc/datalink.js) to reach a pilot via text
// instead of voice - either because they're not currently on that bot's
// frequency (a "contact me" instruction), or to deliver a routine clearance
// as text (a PDC) instead of reading it aloud, e.g. to cut voice-frequency
// congestion during heavy traffic. Comparable in spirit to real-world
// CPDLC/PDC datalink.
app.post('/api/cpdlc', requireIngestAuth, (req, res) => {
  const { callsign, kind, fromPosition, facility, frequency, clearance, text } = req.body || {};
  if (!callsign || typeof callsign !== 'string') return res.status(400).json({ error: '"callsign" is required' });
  if (!['contact', 'pdc', 'text'].includes(kind)) {
    return res.status(400).json({ error: '"kind" must be "contact", "pdc", or "text"' });
  }
  if (kind === 'contact' && (!facility || !frequency)) {
    return res.status(400).json({ error: 'kind "contact" requires "facility" and "frequency"' });
  }
  if (kind === 'pdc' && !clearance) return res.status(400).json({ error: 'kind "pdc" requires "clearance"' });
  if (kind === 'text' && !text) return res.status(400).json({ error: 'kind "text" requires "text"' });

  const key = normalizeCallsign(callsign);
  if (!key) return res.status(400).json({ error: '"callsign" has no usable characters' });

  const message = {
    id: nextCpdlcId++,
    callsign,
    kind,
    fromPosition: typeof fromPosition === 'string' ? fromPosition : null,
    facility: typeof facility === 'string' ? facility : null,
    frequency: typeof frequency === 'string' ? frequency : null,
    clearance: typeof clearance === 'string' ? clearance : null,
    text: typeof text === 'string' ? text : null,
    createdAt: Date.now(),
  };

  const queue = cpdlcMessages.get(key) || [];
  queue.push(message);
  while (queue.length > CPDLC_MAX_PER_CALLSIGN) queue.shift();
  cpdlcMessages.set(key, queue);

  res.status(201).json({ id: message.id });
});

// Pushed by a moderator (see the !tower broadcast chat command) to reach
// every pilot currently polling, not just one callsign - server-wide
// updates/news rather than an ATC instruction to a specific aircraft. Text
// only; "contact"/"pdc" are inherently addressed to one aircraft and don't
// make sense broadcast to everyone.
app.post('/api/cpdlc/broadcast', requireIngestAuth, (req, res) => {
  const { fromPosition, text } = req.body || {};
  if (!text || typeof text !== 'string') return res.status(400).json({ error: '"text" is required' });

  const message = {
    id: nextCpdlcId++,
    callsign: null,
    kind: 'text',
    broadcast: true,
    fromPosition: typeof fromPosition === 'string' ? fromPosition : null,
    facility: null,
    frequency: null,
    clearance: null,
    text,
    createdAt: Date.now(),
  };

  broadcastMessages.push(message);
  while (broadcastMessages.length > CPDLC_MAX_PER_CALLSIGN) broadcastMessages.shift();

  res.status(201).json({ id: message.id });
});

// Polled by the companion app for one callsign. `since` (a message id) lets
// it ask for only what it hasn't already shown, rather than re-fetching and
// re-displaying the same messages every poll. Merges that callsign's direct
// messages with fleet-wide broadcasts - both share one id sequence, so a
// single "since" cursor and a sort by id keeps them in order together.
app.get('/api/cpdlc', requireIngestAuth, (req, res) => {
  const { callsign, since } = req.query;
  if (!callsign || typeof callsign !== 'string') return res.status(400).json({ error: '"callsign" query param is required' });

  const key = normalizeCallsign(callsign);
  const sinceId = Number(since) || 0;
  const now = Date.now();
  const isFresh = (m) => now - m.createdAt < CPDLC_TTL_MS && m.id > sinceId;
  const merged = [...(cpdlcMessages.get(key) || []).filter(isFresh), ...broadcastMessages.filter(isFresh)].sort(
    (a, b) => a.id - b.id
  );
  res.json(merged);
});

// Pushed by the bot fleet (see src/atc/flightStrips.js) whenever a strip is
// created or updated - the dashboard's Flight Strips table (Radar tab)
// shows what's currently being worked, without needing to join the game.
// One row per callsign; a later push replaces the earlier one entirely
// rather than appending, since a strip is mutable state, not a log.
app.post('/api/flightstrip', requireIngestAuth, (req, res) => {
  const { callsign, currentPosition, clearance, updatedAt } = req.body || {};
  if (!callsign || typeof callsign !== 'string') return res.status(400).json({ error: '"callsign" is required' });

  const key = normalizeCallsign(callsign);
  if (!key) return res.status(400).json({ error: '"callsign" has no usable characters' });

  flightStrips.set(key, {
    callsign,
    currentPosition: typeof currentPosition === 'string' ? currentPosition : null,
    clearance: clearance && typeof clearance === 'object' ? clearance : {},
    updatedAt: typeof updatedAt === 'string' ? updatedAt : new Date().toISOString(),
    receivedAt: Date.now(),
  });
  res.status(204).end();
});

// Radar-facing read of every currently-tracked strip - used by the
// dashboard's own Strips panel, same reasoning as /api/dashboard/positions
// above for why this isn't behind requireDashboardAuth. Cross-references
// live positions (if any) purely
// to surface aircraftType, which flight strips don't otherwise carry -
// everything else comes straight from the strip itself.
app.get('/api/dashboard/flightstrips', (req, res) => {
  const now = Date.now();
  const result = [...flightStrips.values()]
    .filter((s) => now - s.receivedAt < FLIGHT_STRIP_TTL_MS)
    .map((s) => {
      const pos = positions.get(normalizeCallsign(s.callsign));
      return {
        callsign: s.callsign,
        aircraftType: pos?.aircraftType || null,
        currentPosition: s.currentPosition,
        clearance: s.clearance,
        updatedAt: s.updatedAt,
      };
    })
    .sort((a, b) => a.callsign.localeCompare(b.callsign));
  res.json(result);
});

// Pushed by BotManagerBot when a pilot runs /fileflightplan - ties a
// callsign to the Discord account that filed it (interaction.user.id),
// which is otherwise unknowable from the companion app's plain-text
// callsign field. A later filing for the same callsign replaces the link
// (re-filing under a new Discord account re-points it), matching how
// flight strips are mutable, latest-wins state rather than a log.
app.post('/api/pilot-link', requireIngestAuth, (req, res) => {
  const { callsign, discordUserId, guildId } = req.body || {};
  if (!callsign || typeof callsign !== 'string') return res.status(400).json({ error: '"callsign" is required' });
  if (!discordUserId || typeof discordUserId !== 'string') return res.status(400).json({ error: '"discordUserId" is required' });
  if (!guildId || typeof guildId !== 'string') return res.status(400).json({ error: '"guildId" is required' });

  const key = normalizeCallsign(callsign);
  if (!key) return res.status(400).json({ error: '"callsign" has no usable characters' });

  pilotLinks.set(key, { callsign, discordUserId, guildId, linkedAt: Date.now() });
  res.status(204).end();
});

// Read by BotManagerBot when resolving a tune request (or a failover
// reassignment) to a specific Discord member to move.
app.get('/api/pilot-link', requireIngestAuth, (req, res) => {
  const { callsign } = req.query;
  if (!callsign || typeof callsign !== 'string') return res.status(400).json({ error: '"callsign" query param is required' });

  const link = pilotLinks.get(normalizeCallsign(callsign));
  if (!link) return res.status(404).json({ error: 'no pilot link on file for that callsign' });
  res.json(link);
});

// Pushed by the companion app when a pilot dials a new frequency (see
// companion/lib/uploader.js's tuneFrequency()). Queued rather than acted on
// here, since actually moving a Discord member requires a live guild.js
// client, which only BotManagerBot has - the monitor just relays the
// request.
app.post('/api/tune', requireIngestAuth, (req, res) => {
  const { callsign, frequency } = req.body || {};
  if (!callsign || typeof callsign !== 'string') return res.status(400).json({ error: '"callsign" is required' });
  if (!frequency || typeof frequency !== 'string') return res.status(400).json({ error: '"frequency" is required' });

  const request = { id: nextTuneRequestId++, callsign, frequency, createdAt: Date.now() };
  tuneRequests.push(request);
  res.status(201).json({ id: request.id });
});

// Polled by BotManagerBot - returns every pending request without removing
// them (removal is explicit via DELETE below, once a move has actually been
// attempted, so a request isn't silently dropped if Bot Manager itself was
// mid-restart when it was posted).
app.get('/api/tune-requests', requireIngestAuth, (req, res) => {
  res.json(tuneRequests);
});

// Acks (removes) one request after BotManagerBot has attempted it,
// success or failure alike - a failed move (e.g. pilot not currently in
// any voice channel to be moved from) isn't worth retrying blindly forever,
// and the pilot can just tune again.
app.delete('/api/tune-requests/:id', requireIngestAuth, (req, res) => {
  const id = Number(req.params.id);
  const index = tuneRequests.findIndex((r) => r.id === id);
  if (index === -1) return res.status(404).json({ error: 'no such tune request' });
  tuneRequests.splice(index, 1);
  res.status(204).end();
});

app.use(requireDashboardAuth, express.static(path.join(__dirname, 'public')));

const server = app.listen(PORT, () => {
  console.log(`[monitor] listening on port ${PORT}`);
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  if (DASHBOARD_USERNAME && DASHBOARD_PASSWORD) {
    const auth = req.headers.authorization || '';
    let authorized = false;
    if (auth.startsWith('Basic ')) {
      const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      const separatorIndex = decoded.indexOf(':');
      const user = decoded.slice(0, separatorIndex);
      const pass = decoded.slice(separatorIndex + 1);
      authorized = user === DASHBOARD_USERNAME && pass === DASHBOARD_PASSWORD;
    }
    if (!authorized) {
      ws.close(4001, 'unauthorized');
      return;
    }
  }

  ws.send(JSON.stringify({ type: 'snapshot', logs: logs.slice(-200) }));
});

function broadcast(entry) {
  const payload = JSON.stringify({ type: 'log', entry });
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
}
