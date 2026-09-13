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

// Read by the bot fleet (Approach/Departure/Center) to ground vectoring in
// an actual reported position instead of guessing - same trust tier as
// ingest, since this is a server-to-server call, not a human dashboard view.
app.get('/api/positions', requireIngestAuth, (req, res) => {
  const now = Date.now();
  const result = [...positions.values()]
    .filter((p) => now - p.receivedAt < POSITION_STALE_MS)
    .map(({ callsign, aircraftType, speed, position, receivedAt }) => ({
      callsign,
      aircraftType,
      speed,
      position,
      ageMs: now - receivedAt,
    }));
  res.json(result);
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
