// Remote control for the FMS / autopilot: a small web server on the pilot's
// own PC that a phone or tablet on the same Wi-Fi opens in its browser, so
// the MCDU and autopilot panel can be worked without touching the PC's
// mouse (which PTFS steers with - touching it disconnects the autopilot).
//
// - GET  /                     the remote page (remote/index.html + assets)
// - GET  /api/check            204 if the pairing code is right, else 401
// - GET  /api/events?code=     Server-Sent Events: the cockpit view model,
//                              pushed every time the FMS window redraws
// - POST /api/input            one cockpit input message (see fmsView.js)
//
// Off unless the pilot turns it on in the FMS window's Settings. Every API
// request needs the 6-digit pairing code shown there (a new code
// disconnects everyone), repeated wrong codes from one address are locked
// out for a minute, and only a fixed list of files is ever served. No
// internet involved - it only listens on the PC's own network.

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
// URL -> [file on disk, content type]. Nothing outside this list is served.
const FILES = {
  '/': ['remote/index.html', 'text/html; charset=utf-8'],
  '/remote.js': ['remote/remote.js', 'text/javascript; charset=utf-8'],
  '/remote.css': ['remote/remote.css', 'text/css; charset=utf-8'],
  '/manifest.json': ['remote/manifest.json', 'application/manifest+json'],
  '/icon.svg': ['remote/icon.svg', 'image/svg+xml'],
  '/fms.css': ['renderer/fms.css', 'text/css; charset=utf-8'],
  '/fmsView.js': ['renderer/fmsView.js', 'text/javascript; charset=utf-8'],
};

const MAX_BODY_BYTES = 4096;
const LOCKOUT_FAILURES = 10;
const LOCKOUT_MS = 60_000;
const KEEPALIVE_MS = 15_000;

function newPairingCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function sameCode(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** The addresses a phone on the same network can reach this PC at. */
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

/**
 * Creates the server. `onInput(message)` receives each cockpit input;
 * `onClients(count)` is told whenever a remote connects or disconnects.
 */
function createRemoteServer({ onInput, onClients = () => {} }) {
  let server = null;
  let code = null;
  let lastView = null;
  const clients = new Set(); // open SSE responses
  const failures = new Map(); // ip -> {count, since}

  const lockedOut = (ip) => {
    const f = failures.get(ip);
    return Boolean(f && f.count >= LOCKOUT_FAILURES && Date.now() - f.since < LOCKOUT_MS);
  };
  const noteFailure = (ip) => {
    const f = failures.get(ip);
    if (!f || Date.now() - f.since > LOCKOUT_MS) failures.set(ip, { count: 1, since: Date.now() });
    else f.count += 1;
  };

  // true if authorized; otherwise answers the request itself.
  function authorize(req, res, given) {
    const ip = req.socket.remoteAddress;
    if (lockedOut(ip)) {
      res.writeHead(429).end('Too many wrong codes - wait a minute');
      return false;
    }
    if (!sameCode(given, code)) {
      noteFailure(ip);
      res.writeHead(401).end('Wrong pairing code');
      return false;
    }
    failures.delete(ip);
    return true;
  }

  function sendEvent(res, view) {
    res.write(`event: view\ndata: ${JSON.stringify(view)}\n\n`);
  }

  function handle(req, res) {
    const url = new URL(req.url, 'http://remote');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (req.method === 'GET' && FILES[url.pathname]) {
      const [file, type] = FILES[url.pathname];
      fs.readFile(path.join(ROOT, file), (err, body) => {
        if (err) return res.writeHead(500).end();
        res.writeHead(200, { 'Content-Type': type }).end(body);
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/check') {
      if (authorize(req, res, url.searchParams.get('code'))) res.writeHead(204).end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      if (!authorize(req, res, url.searchParams.get('code'))) return;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      if (lastView) sendEvent(res, lastView);
      clients.add(res);
      onClients(clients.size);
      const keepalive = setInterval(() => res.write(': keepalive\n\n'), KEEPALIVE_MS);
      req.on('close', () => {
        clearInterval(keepalive);
        clients.delete(res);
        onClients(clients.size);
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/input') {
      if (!authorize(req, res, req.headers['x-pairing-code'])) return;
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > MAX_BODY_BYTES) req.destroy();
      });
      req.on('end', () => {
        try {
          onInput(JSON.parse(body));
          res.writeHead(204).end();
        } catch {
          res.writeHead(400).end('Bad input');
        }
      });
      return;
    }

    res.writeHead(404).end('Not found');
  }

  function disconnectAll() {
    for (const res of clients) res.end();
    clients.clear();
    onClients(0);
  }

  return {
    /** Starts (or restarts) listening. Resolves {port, urls}. */
    start({ port, pairingCode }) {
      code = pairingCode;
      return new Promise((resolve, reject) => {
        const begin = () => {
          server = http.createServer(handle);
          server.once('error', reject);
          server.listen(port, '0.0.0.0', () => {
            const actual = server.address().port;
            resolve({ port: actual, urls: lanAddresses().map((ip) => `http://${ip}:${actual}`) });
          });
        };
        if (server) this.stop().then(begin);
        else begin();
      });
    },
    stop() {
      disconnectAll();
      if (!server) return Promise.resolve();
      const s = server;
      server = null;
      return new Promise((resolve) => s.close(() => resolve()));
    },
    /** A new pairing code: everyone connected must pair again. */
    setCode(pairingCode) {
      code = pairingCode;
      disconnectAll();
    },
    /** Sends the latest cockpit view to every connected remote. */
    publish(view) {
      lastView = view;
      for (const res of clients) sendEvent(res, view);
    },
    get running() {
      return Boolean(server);
    },
  };
}

module.exports = { createRemoteServer, newPairingCode, lanAddresses };
