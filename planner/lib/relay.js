// Remote-control relay: lets a phone anywhere work a pilot's FMS/autopilot
// in the companion app, through this public service, without the pilot's
// PC accepting any incoming connection.
//
//   phone ──HTTPS──▶ relay (this) ◀──HTTPS── companion app (connects out)
//
// The companion app ("host") picks a 12-character connection code and a
// long secret, then:
//   GET  /remote/api/host?code=&secret=   SSE: phone inputs + phone count
//   POST /remote/api/host/view            {code, secret, view} - the cockpit
// A phone, on the remote page this service serves at /remote/:
//   GET  /remote/api/check?code=          204 if that pilot is online
//   GET  /remote/api/events?code=         SSE: the pilot's cockpit view
//   POST /remote/api/input                {message} + X-Pairing-Code header
//
// The code is the phone's only credential, so it's long (60 bits - not
// guessable) and wrong guesses lock the guessing address out. The secret
// (never shown to anyone) stops someone who knows a code from posing as
// that pilot's PC. Nothing is stored: a session exists only while its
// companion app is connected. What a phone may actually do with the
// cockpit is decided by the companion app (e.g. it never lets a phone
// switch the autopilot to LIVE).

const crypto = require('crypto');
const express = require('express');

const CODE_RE = /^[A-HJ-NP-Z2-9]{12}$/; // same alphabet as plan IDs: no 0/O/1/I
const SECRET_RE = /^[a-f0-9]{64}$/;
const MAX_SESSIONS = 2000;
const MAX_PHONES_PER_SESSION = 5;
const MAX_VIEW_BYTES = 64 * 1024;
const LOCKOUT_FAILURES = 10;
const LOCKOUT_MS = 60_000;
const KEEPALIVE_MS = 15_000;

const normalizeCode = (raw) => String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function openStream(res) {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 2000\n\n');
  return setInterval(() => res.write(': keepalive\n\n'), KEEPALIVE_MS);
}

const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

function createRelayRouter() {
  const router = express.Router();
  const sessions = new Map(); // code -> {secret, host, phones:Set, lastView}
  const failures = new Map(); // ip -> {count, since}

  const lockedOut = (ip) => {
    const f = failures.get(ip);
    return Boolean(f && f.count >= LOCKOUT_FAILURES && Date.now() - f.since < LOCKOUT_MS);
  };
  const noteFailure = (ip) => {
    const f = failures.get(ip);
    if (!f || Date.now() - f.since > LOCKOUT_MS) failures.set(ip, { count: 1, since: Date.now() });
    else f.count += 1;
    if (failures.size > 10_000) failures.clear(); // memory bound under abuse
  };

  // The session a phone's code names, or null (and the response handled).
  function phoneSession(req, res, rawCode) {
    if (lockedOut(req.ip)) {
      res.status(429).send('Too many wrong codes - wait a minute');
      return null;
    }
    const session = sessions.get(normalizeCode(rawCode));
    if (!session || !session.host) {
      noteFailure(req.ip);
      res.status(404).send('No pilot online with that code');
      return null;
    }
    return session;
  }

  const tellHostPhoneCount = (session) => {
    if (session.host) send(session.host, 'clients', session.phones.size);
  };

  // ---- companion app (host)

  router.get('/api/host', (req, res) => {
    const code = normalizeCode(req.query.code);
    const secret = String(req.query.secret || '');
    if (!CODE_RE.test(code) || !SECRET_RE.test(secret)) return res.status(400).send('Bad code or secret');
    let session = sessions.get(code);
    if (session && !safeEqual(session.secret, secret)) return res.status(409).send('Code in use - pick another');
    if (!session) {
      if (sessions.size >= MAX_SESSIONS) return res.status(503).send('Relay full - try later');
      session = { secret, host: null, phones: new Set(), lastView: null };
      sessions.set(code, session);
    }
    if (session.host) session.host.end(); // the same PC reconnecting replaces its old link
    const keepalive = openStream(res);
    session.host = res;
    tellHostPhoneCount(session);
    req.on('close', () => {
      clearInterval(keepalive);
      if (session.host !== res) return;
      session.host = null;
      // Pilot offline: phones see that, and the session goes away.
      for (const phone of session.phones) phone.end();
      sessions.delete(code);
    });
    return undefined;
  });

  router.post('/api/host/view', express.json({ limit: MAX_VIEW_BYTES }), (req, res) => {
    const { code, secret, view } = req.body || {};
    const session = sessions.get(normalizeCode(code));
    if (!session || !safeEqual(session.secret, secret)) return res.status(401).send('Unknown session');
    session.lastView = view;
    for (const phone of session.phones) send(phone, 'view', view);
    return res.status(204).end();
  });

  // ---- phone

  router.get('/api/check', (req, res) => {
    if (phoneSession(req, res, req.query.code)) res.status(204).end();
  });

  router.get('/api/events', (req, res) => {
    const session = phoneSession(req, res, req.query.code);
    if (!session) return;
    if (session.phones.size >= MAX_PHONES_PER_SESSION) {
      res.status(429).send('Too many devices connected to this pilot');
      return;
    }
    const keepalive = openStream(res);
    if (session.lastView) send(res, 'view', session.lastView);
    session.phones.add(res);
    tellHostPhoneCount(session);
    req.on('close', () => {
      clearInterval(keepalive);
      session.phones.delete(res);
      tellHostPhoneCount(session);
    });
  });

  router.post('/api/input', express.json({ limit: '4kb' }), (req, res) => {
    const session = phoneSession(req, res, req.get('x-pairing-code'));
    if (!session) return;
    if (!req.body || typeof req.body !== 'object') {
      res.status(400).send('Bad input');
      return;
    }
    send(session.host, 'input', req.body);
    res.status(204).end();
  });

  return router;
}

module.exports = { createRelayRouter, normalizeCode, CODE_RE };
