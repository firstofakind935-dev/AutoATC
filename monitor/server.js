require('dotenv').config();

const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const INGEST_API_KEY = process.env.INGEST_API_KEY || null;
const DASHBOARD_USERNAME = process.env.DASHBOARD_USERNAME || null;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || null;

const MAX_LOGS = 5000;
const OFFLINE_THRESHOLD_MS = 90_000; // matches the bot fleet's heartbeat interval (60s) with margin
const POSITION_STALE_MS = 30_000; // a position report older than this is dropped from /api/positions - stale beats wrong
const CPDLC_MAX_PER_CALLSIGN = 20; // ring buffer per callsign - old ones age out via CPDLC_TTL_MS below anyway
const CPDLC_TTL_MS = 10 * 60_000; // a "contact me"/PDC message nobody's polled for in 10 minutes isn't worth surfacing late

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

const logs = []; // ring buffer, oldest first
const botStatus = new Map(); // bot name -> { lastSeen, lastLevel, lastMessage }
const positions = new Map(); // normalized callsign -> { callsign, aircraftType, speed, position, receivedAt }
const cpdlcMessages = new Map(); // normalized callsign -> array of messages, oldest first
const broadcastMessages = []; // fleet-wide announcements, oldest first - see POST /api/cpdlc/broadcast
let nextCpdlcId = 1; // shared across per-callsign and broadcast messages, so a single "since" cursor covers both

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
    }));
}

// Read by the bot fleet (Approach/Departure/Center) to ground vectoring in
// an actual reported position instead of guessing - same trust tier as
// ingest, since this is a server-to-server call, not a human dashboard view.
app.get('/api/positions', requireIngestAuth, (req, res) => {
  res.json(freshPositions());
});

// Same data, for the dashboard's radar view (see public/radar.js) - a
// separate route rather than reusing /api/positions above because the
// dashboard authenticates with Basic auth (a browser session) while that
// one expects a Bearer token (a server-to-server credential); the two
// schemes can't cleanly share one route.
app.get('/api/dashboard/positions', requireDashboardAuth, (req, res) => {
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
