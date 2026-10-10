// The companion app's side of remote control from anywhere: connects OUT to
// the flight planner's relay (planner/lib/relay.js), so a phone on any
// network can work the FMS/autopilot without this PC accepting incoming
// connections (no router or firewall setup).
//
// Holds one long-lived Server-Sent Events stream from the relay (phone
// inputs and how many phones are connected) and posts the cockpit view back
// whenever it changes - only while a phone is actually connected. Reconnects
// by itself, with backoff, if the internet or the relay drops.
//
// `fetchImpl` is injectable for tests; Electron's main process has fetch.

const crypto = require('crypto');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I - typed on a phone
const RETRY_MIN_MS = 2000;
const RETRY_MAX_MS = 30000;

/** A fresh 12-character connection code and a 64-hex-digit secret. */
function newRelayCredentials() {
  const bytes = crypto.randomBytes(12);
  const code = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  return { code, secret: crypto.randomBytes(32).toString('hex') };
}

/** "K7Q29XMP4HDA" -> "K7Q2-9XMP-4HDA", for showing to the pilot. */
const formatCode = (code) => String(code || '').match(/.{1,4}/g)?.join('-') || '';

// Feeds raw SSE text in; calls onEvent(name, data) per complete event.
function createSseParser(onEvent) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk;
    let split;
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      let name = 'message';
      const data = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) name = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (data.length) onEvent(name, data.join('\n'));
    }
  };
}

/**
 * onInput(message) - a phone pressed something.
 * onClients(count) - phones connected now.
 * onStatus(state, detail) - 'connecting' | 'connected' | 'offline' | 'error'.
 */
function createRelayClient({ fetchImpl = (...a) => fetch(...a), onInput, onClients = () => {}, onStatus = () => {} }) {
  let config = null; // {baseUrl, code, secret}
  let abort = null;
  let retryTimer = null;
  let retryMs = RETRY_MIN_MS;
  let phones = 0;
  let pendingView = null;
  let posting = false;

  const base = () => config.baseUrl.replace(/\/$/, '');

  async function flushView() {
    if (posting || !pendingView || !config || phones === 0) return;
    posting = true;
    const view = pendingView;
    pendingView = null;
    try {
      await fetchImpl(`${base()}/remote/api/host/view`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: config.code, secret: config.secret, view }),
      });
    } catch {
      // The stream's own reconnect handles a dropped relay.
    } finally {
      posting = false;
      if (pendingView) flushView(); // a newer view arrived meanwhile
    }
  }

  function scheduleRetry(detail) {
    onStatus('offline', detail);
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, retryMs);
    retryMs = Math.min(RETRY_MAX_MS, retryMs * 2);
  }

  async function connect() {
    if (!config) return;
    const mine = new AbortController();
    abort = mine;
    onStatus('connecting');
    const url = `${base()}/remote/api/host?code=${encodeURIComponent(config.code)}&secret=${encodeURIComponent(config.secret)}`;
    let res;
    try {
      res = await fetchImpl(url, { signal: mine.signal, headers: { Accept: 'text/event-stream' } });
    } catch (err) {
      if (abort === mine) scheduleRetry(err.message);
      return;
    }
    if (res.status === 409) return onStatus('error', 'conflict'); // code taken - caller picks a new one
    if (!res.ok) {
      if (res.status >= 500 || res.status === 429) scheduleRetry(`relay answered ${res.status}`);
      else onStatus('error', `relay answered ${res.status}`);
      return;
    }

    retryMs = RETRY_MIN_MS;
    onStatus('connected');
    const parse = createSseParser((name, data) => {
      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        return;
      }
      if (name === 'input') onInput(payload);
      if (name === 'clients') {
        phones = Number(payload) || 0;
        onClients(phones);
        flushView(); // a phone just connected - send it the cockpit now
      }
    });
    const decoder = new TextDecoder();
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parse(decoder.decode(value, { stream: true }));
      }
    } catch {
      // Stream dropped (network change, relay restart) - reconnect below.
    }
    if (abort === mine) {
      phones = 0;
      onClients(0);
      scheduleRetry('connection lost');
    }
  }

  return {
    start(next) {
      this.stop();
      config = { ...next };
      retryMs = RETRY_MIN_MS;
      connect();
    },
    stop() {
      config = null;
      clearTimeout(retryTimer);
      if (abort) abort.abort();
      abort = null;
      phones = 0;
      pendingView = null;
    },
    /** The latest cockpit view; sent on to the relay if a phone is watching. */
    publish(view) {
      if (!config) return;
      pendingView = view;
      flushView();
    },
  };
}

module.exports = { createRelayClient, newRelayCredentials, formatCode, createSseParser };
