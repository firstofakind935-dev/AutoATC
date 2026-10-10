const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createRemoteServer, newPairingCode } = require('../companion/lib/remoteServer');

const CODE = '123456';

async function startServer() {
  const inputs = [];
  const clientCounts = [];
  const server = createRemoteServer({ onInput: (m) => inputs.push(m), onClients: (n) => clientCounts.push(n) });
  const { port } = await server.start({ port: 0, pairingCode: CODE });
  return { server, base: `http://127.0.0.1:${port}`, inputs, clientCounts };
}

// Reads the first `view` event from an SSE stream.
function firstView(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk;
        const m = buf.match(/event: view\ndata: (.*)\n\n/);
        if (m) {
          req.destroy();
          resolve(JSON.parse(m[1]));
        }
      });
    });
    req.on('error', reject);
  });
}

test('pairing codes are 6 digits', () => {
  for (let i = 0; i < 50; i++) assert.match(newPairingCode(), /^\d{6}$/);
});

test('serves the remote page and only its listed files', async () => {
  const { server, base } = await startServer();
  try {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /AutoATC FMS/);
    assert.equal((await fetch(`${base}/fmsView.js`)).status, 200);
    for (const path of ['/main.js', '/../main.js', '/%2e%2e/main.js', '/lib/remoteServer.js', '/renderer/fms.js']) {
      assert.equal((await fetch(`${base}${path}`)).status, 404, path);
    }
  } finally {
    await server.stop();
  }
});

test('API calls need the pairing code', async () => {
  const { server, base, inputs } = await startServer();
  try {
    assert.equal((await fetch(`${base}/api/check?code=000000`)).status, 401);
    assert.equal((await fetch(`${base}/api/check?code=${CODE}`)).status, 204);
    const post = (code) => fetch(`${base}/api/input`, { method: 'POST', headers: { 'X-Pairing-Code': code }, body: JSON.stringify({ type: 'key', ch: 'A' }) });
    assert.equal((await post('999999')).status, 401);
    assert.equal(inputs.length, 0);
    assert.equal((await post(CODE)).status, 204);
    assert.deepEqual(inputs, [{ type: 'key', ch: 'A' }]);
    assert.equal((await fetch(`${base}/api/events?code=nope`)).status, 401);
  } finally {
    await server.stop();
  }
});

test('connected remotes get the latest view, then every update', async () => {
  const { server, base, clientCounts } = await startServer();
  try {
    server.publish({ n: 1 });
    assert.deepEqual(await firstView(`${base}/api/events?code=${CODE}`), { n: 1 }, 'the last view on connect');
    assert.ok(clientCounts.includes(1));
  } finally {
    await server.stop();
  }
});

test('a new pairing code disconnects everyone and refuses the old code', async () => {
  const { server, base } = await startServer();
  try {
    server.publish({ n: 1 });
    const closed = new Promise((resolve) => {
      http.get(`${base}/api/events?code=${CODE}`, (res) => {
        res.on('data', () => {});
        res.on('end', resolve);
      });
    });
    await new Promise((r) => setTimeout(r, 50));
    server.setCode('654321');
    await closed;
    assert.equal((await fetch(`${base}/api/check?code=${CODE}`)).status, 401);
    assert.equal((await fetch(`${base}/api/check?code=654321`)).status, 204);
  } finally {
    await server.stop();
  }
});

test('bad input bodies are rejected, not passed on', async () => {
  const { server, base, inputs } = await startServer();
  try {
    const res = await fetch(`${base}/api/input`, { method: 'POST', headers: { 'X-Pairing-Code': CODE }, body: '{not json' });
    assert.equal(res.status, 400);
    assert.equal(inputs.length, 0);
  } finally {
    await server.stop();
  }
});
