const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createRelayClient, newRelayCredentials, formatCode, createSseParser } = require('../companion/lib/relayClient');

// The relay runs inside the planner and needs its dependencies.
let express = null;
let createRelayRouter = null;
try {
  express = require('../planner/node_modules/express');
  ({ createRelayRouter } = require('../planner/lib/relay'));
} catch {
  // Skipped below.
}
const skip = !express && 'run "npm install" in planner/ first';

async function startRelay() {
  const app = express();
  app.use('/remote', createRelayRouter());
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

const waitFor = async (fn, ms = 2000) => {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

// A phone's live view stream; collects every view event.
function phoneStream(url) {
  const views = [];
  let ended = false;
  let status = null;
  const parse = createSseParser((name, data) => {
    if (name === 'view') views.push(JSON.parse(data));
  });
  const req = http.get(url, (res) => {
    status = res.statusCode;
    res.setEncoding('utf8');
    res.on('data', parse);
    res.on('end', () => { ended = true; });
  });
  req.on('error', () => { ended = true; });
  return { views, get ended() { return ended; }, get status() { return status; }, close: () => req.destroy() };
}

test('connection codes are 12 characters with no look-alike letters, shown in groups of 4', () => {
  const { code, secret } = newRelayCredentials();
  assert.match(code, /^[A-HJ-NP-Z2-9]{12}$/);
  assert.match(secret, /^[a-f0-9]{64}$/);
  assert.equal(formatCode('K7Q29XMP4HDA'), 'K7Q2-9XMP-4HDA');
});

test('phone and PC meet through the relay: views out, inputs back', { skip }, async () => {
  const relay = await startRelay();
  const { code, secret } = newRelayCredentials();
  const inputs = [];
  const counts = [];
  const statuses = [];
  const client = createRelayClient({ onInput: (m) => inputs.push(m), onClients: (n) => counts.push(n), onStatus: (s) => statuses.push(s) });
  try {
    // No PC yet: the code finds nobody.
    assert.equal((await fetch(`${relay.base}/remote/api/check?code=${code}`)).status, 404);

    client.start({ baseUrl: relay.base, code, secret });
    await waitFor(() => statuses.includes('connected'));
    client.publish({ page: 'RTE', n: 1 });

    // Typed with dashes and in lower case still works.
    const typed = formatCode(code).toLowerCase();
    assert.equal((await fetch(`${relay.base}/remote/api/check?code=${typed}`)).status, 204);

    const phone = phoneStream(`${relay.base}/remote/api/events?code=${code}`);
    await waitFor(() => phone.views.length >= 1);
    assert.deepEqual(phone.views[0], { page: 'RTE', n: 1 }, 'the phone gets the cockpit as soon as it connects');
    await waitFor(() => counts.includes(1));

    client.publish({ page: 'LEGS', n: 2 });
    await waitFor(() => phone.views.length >= 2);
    assert.equal(phone.views[1].page, 'LEGS');

    const res = await fetch(`${relay.base}/remote/api/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Pairing-Code': code },
      body: JSON.stringify({ type: 'lsk', id: 'L2' }),
    });
    assert.equal(res.status, 204);
    await waitFor(() => inputs.length === 1);
    assert.deepEqual(inputs[0], { type: 'lsk', id: 'L2' });

    // PC goes offline: the phone's stream ends and the code finds nobody.
    client.stop();
    await waitFor(() => phone.ended);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await fetch(`${relay.base}/remote/api/check?code=${code}`)).status, 404);
  } finally {
    client.stop();
    await relay.close();
  }
});

test("someone who knows a code can't pose as that pilot's PC", { skip }, async () => {
  const relay = await startRelay();
  const { code, secret } = newRelayCredentials();
  const statuses = [];
  const client = createRelayClient({ onInput: () => {}, onStatus: (s) => statuses.push(s) });
  try {
    client.start({ baseUrl: relay.base, code, secret });
    await waitFor(() => statuses.includes('connected'));
    const other = newRelayCredentials().secret;
    assert.equal((await fetch(`${relay.base}/remote/api/host?code=${code}&secret=${other}`)).status, 409);
    const post = await fetch(`${relay.base}/remote/api/host/view`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, secret: other, view: { fake: true } }),
    });
    assert.equal(post.status, 401);
  } finally {
    client.stop();
    await relay.close();
  }
});

test('the PC reconnects by itself after the relay restarts', { skip }, async () => {
  let relay = await startRelay();
  const port = Number(relay.base.split(':').pop());
  const { code, secret } = newRelayCredentials();
  const statuses = [];
  const client = createRelayClient({ onInput: () => {}, onStatus: (s) => statuses.push(s) });
  try {
    client.start({ baseUrl: relay.base, code, secret });
    await waitFor(() => statuses.includes('connected'));
    await relay.close();
    await waitFor(() => statuses.includes('offline'));
    // Same port again.
    const app = express();
    app.use('/remote', createRelayRouter());
    const server = await new Promise((resolve) => { const s = app.listen(port, '127.0.0.1', () => resolve(s)); });
    relay = { base: relay.base, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
    const before = statuses.filter((s) => s === 'connected').length;
    await waitFor(() => statuses.filter((s) => s === 'connected').length > before, 6000);
    assert.equal((await fetch(`${relay.base}/remote/api/check?code=${code}`)).status, 204);
  } finally {
    client.stop();
    await relay.close();
  }
});
