// The radio hub: pilots on a frequency hear each other live, one transmitter at a time, and the AI controller's
// reply reaches everyone tuned there; a human controller on a frequency silences the AI.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const WebSocket = require('../monitor/node_modules/ws');
const { createRadioHub } = require('../monitor/radio');

async function setup({ controllerKey = null } = {}) {
  const hub = createRadioHub({ workerKey: 'k', controllerKey, logger: { info() {} } });
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => { if (!hub.handleUpgrade(req, socket, head)) socket.destroy(); });
  await new Promise((r) => server.listen(0, r));
  const base = `ws://127.0.0.1:${server.address().port}`;
  const open = (path, opts) => new Promise((resolve, reject) => {
    const ws = new WebSocket(base + path, opts);
    ws.inbox = [];
    ws.on('message', (d, bin) => ws.inbox.push(bin ? d : JSON.parse(d.toString())));
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
  const done = () => { hub.close(); server.close(); };
  return { hub, open, done };
}
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const json = (ws, type) => ws.inbox.filter((m) => !Buffer.isBuffer(m) && m.type === type);

test('live audio, busy frequency, utterance to the brain, reply to everyone', async () => {
  const { open, done } = await setup();
  try {
    const worker = await open('/radio/worker', { headers: { authorization: 'Bearer k' } });
    worker.send(JSON.stringify({ type: 'hello', stations: [{ freq: '121.000', station: 'IRFD TWR', callsign: 'Rockford Tower' }] }));
    const a = await open('/radio?callsign=N42Y');
    const b = await open('/radio?callsign=DAL123');
    await tick();
    assert.strictEqual(json(a, 'hello')[0].stations[0].station, 'IRFD TWR');
    for (const p of [a, b]) p.send(JSON.stringify({ type: 'tune', tx: '121.000', rx: ['121.000'] }));
    await tick();
    a.send(JSON.stringify({ type: 'ptt', on: true }));
    await tick();
    assert.strictEqual(json(a, 'ptt')[0].granted, true);
    b.send(JSON.stringify({ type: 'ptt', on: true }));
    await tick();
    assert.strictEqual(json(b, 'ptt')[0].granted, false, 'frequency busy');
    assert.match(json(b, 'ptt')[0].reason, /N42Y/);
    const pcm = Buffer.alloc(16000 * 2); // 1 s of audio
    a.send(pcm.subarray(0, 16000)); a.send(pcm.subarray(16000));
    await tick();
    const frames = b.inbox.filter(Buffer.isBuffer);
    assert.strictEqual(json(b, 'rx-start')[0].from, 'N42Y');
    assert.strictEqual(frames.reduce((n, f) => n + f.length - 2, 0), 32000, 'B heard all of it live');
    a.send(JSON.stringify({ type: 'ptt', on: false }));
    await tick();
    assert.strictEqual(json(b, 'rx-end').length, 1);
    const utt = json(worker, 'utterance')[0];
    assert.strictEqual(utt.from, 'N42Y');
    assert.strictEqual(Buffer.from(utt.audio, 'base64').length, 32000);
    worker.send(JSON.stringify({ type: 'transcript', id: utt.id, freq: '121.000', from: 'N42Y', text: 'Rockford Tower, N42Y ready' }));
    worker.send(JSON.stringify({ type: 'reply', id: utt.id, freq: '121.000', from: 'Rockford Tower', text: 'N42Y, cleared for takeoff', audio: 'AAAA' }));
    await tick();
    for (const p of [a, b]) {
      assert.strictEqual(json(p, 'rx-clip')[0].text, 'N42Y, cleared for takeoff');
      assert.strictEqual(json(p, 'rx-text')[0].text, 'Rockford Tower, N42Y ready');
    }
    b.send(JSON.stringify({ type: 'ptt', on: true }));
    await tick();
    assert.strictEqual(json(b, 'ptt').at(-1).granted, true, 'free again');
    for (const w of [a, b, worker]) w.close();
  } finally { done(); }
});

test('human controllers take over and hand back: the AI only listens meanwhile, history comes with the takeover', async () => {
  const { open, done } = await setup({ controllerKey: 'ctl' });
  try {
    await assert.rejects(open('/radio/worker'), /401/);
    await assert.rejects(open('/radio?role=controller&callsign=Bob&key=wrong'), /401/);
    const worker = await open('/radio/worker', { headers: { authorization: 'Bearer k' } });
    worker.send(JSON.stringify({ type: 'hello', stations: [{ freq: '118.100', station: 'IRFD GND', callsign: 'Rockford Ground' }] }));
    const pilot = await open('/radio?callsign=N1');
    await tick();
    pilot.send(JSON.stringify({ type: 'tune', tx: '118.100' }));
    const talk = async (who) => { who.send(JSON.stringify({ type: 'ptt', on: true })); await tick(); who.send(Buffer.alloc(16000)); who.send(JSON.stringify({ type: 'ptt', on: false })); await tick(); };
    // the AI handles a call; it goes into the frequency's history
    await talk(pilot);
    const u1 = json(worker, 'utterance')[0];
    assert.strictEqual(u1.listenOnly, false);
    worker.send(JSON.stringify({ type: 'transcript', id: u1.id, freq: '118.100', from: 'N1', text: 'Rockford Ground, N1, request taxi' }));
    worker.send(JSON.stringify({ type: 'reply', id: u1.id, freq: '118.100', from: 'Rockford Ground', text: 'N1, taxi via A to 25L' }));
    await tick();

    const human = await open('/radio?role=controller&callsign=Bob&key=ctl');
    await tick();
    human.send(JSON.stringify({ type: 'tune', tx: '118.100', rx: ['118.100'] }));
    await tick();
    human.send(JSON.stringify({ type: 'ptt', on: true }));
    await tick();
    assert.strictEqual(json(human, 'ptt').at(-1).granted, false, 'must take over before transmitting');
    assert.strictEqual(json(pilot, 'stations').length ? json(pilot, 'stations').at(-1).stations[0].staffed : undefined, undefined, 'listening alone does not take it');

    human.send(JSON.stringify({ type: 'takeover', freq: '118.100' }));
    await tick();
    assert.strictEqual(json(human, 'takeover')[0].ok, true);
    assert.deepStrictEqual(json(human, 'history')[0].lines.map((l) => l.text), ['Rockford Ground, N1, request taxi', 'N1, taxi via A to 25L']);
    assert.strictEqual(json(pilot, 'stations').at(-1).stations[0].staffed, 'human');

    await talk(pilot);
    assert.strictEqual(json(worker, 'utterance').at(-1).listenOnly, true, 'the AI only listens');
    assert.ok(human.inbox.some(Buffer.isBuffer), 'the controller heard the pilot');
    await talk(human);
    const fromHuman = json(worker, 'utterance').at(-1);
    assert.deepStrictEqual([fromHuman.listenOnly, fromHuman.speaker, fromHuman.from], [true, 'controller', 'Bob']);
    // a late AI reply is dropped while the human has it
    worker.send(JSON.stringify({ type: 'reply', id: 99, freq: '118.100', from: 'Rockford Ground', text: 'late' }));
    await tick();
    assert.ok(!json(pilot, 'rx-clip').some((c) => c.text === 'late'));

    const other = await open('/radio?role=controller&callsign=Ann&key=ctl');
    other.send(JSON.stringify({ type: 'takeover', freq: '118.100' }));
    await tick();
    assert.match(json(other, 'takeover')[0].reason, /Bob already has it/);

    human.send(JSON.stringify({ type: 'handback', freq: '118.100' }));
    await tick();
    assert.strictEqual(json(pilot, 'stations').at(-1).stations[0].staffed, undefined);
    await talk(pilot);
    assert.strictEqual(json(worker, 'utterance').at(-1).listenOnly, false, 'the AI answers again');

    other.send(JSON.stringify({ type: 'takeover', freq: '118.100' }));
    await tick();
    other.close();
    await tick();
    await talk(pilot);
    assert.strictEqual(json(worker, 'utterance').at(-1).listenOnly, false, 'a controller who disconnects hands back');
    for (const w of [pilot, worker, human]) w.close();
  } finally { done(); }
});
