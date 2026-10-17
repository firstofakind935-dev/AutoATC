// The controller brain behind the in-app radio: every station on the frequency list gets a persona, and a pilot's
// transmission through the hub comes back as the right station's spoken reply.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const WebSocket = require('../monitor/node_modules/ws');

test('every station on the frequency list is answered, Discord bot or not', () => {
  const { loadStations, positionFor } = require('../src/radio/radioWorker');
  const stations = loadStations();
  const freqs = require('../data/frequencies.json');
  assert.strictEqual(stations.length, freqs.length);
  const byStation = Object.fromEntries(stations.map((s) => [s.station, s]));
  assert.strictEqual(byStation['IRFD TWR'].persona.callsign, 'Rockford Tower');
  assert.strictEqual(byStation['IRFD TWR'].freq, '121.000');
  assert.strictEqual(byStation['Shanwick OCC'].persona.position, 'Oceanic'); // no Discord bot for it
  assert.strictEqual(byStation['USS TWR'].persona.airport, 'USS');
  assert.strictEqual(byStation['HMS TWR'].persona.airport, 'HMS');
  assert.strictEqual(positionFor('IRCC'), 'Center');
  assert.strictEqual(positionFor('ISAU APRON'), 'Apron');
});

test('a transmission through the hub is transcribed, answered by that station and spoken back', async (t) => {
  // stand-ins for the paid services
  const stt = require('../src/speech/stt');
  const tts = require('../src/speech/tts');
  const llm = require('../src/ai/llmProvider');
  t.mock.method(stt, 'transcribeAudio', async (wav) => {
    assert.strictEqual(wav.readUInt32LE(24), 16000, 'a 16 kHz WAV');
    assert.strictEqual(wav.readUInt16LE(22), 1, 'mono');
    return 'Rockford Tower, N42Y, holding short runway 25L, ready for departure';
  });
  t.mock.method(tts, 'synthesizeSpeech', async (text) => Buffer.from(`MP3:${text}`));
  t.mock.method(llm, 'generateAtcReplyWithFallback', async (args) => {
    assert.match(args.systemPrompt, /Rockford Tower/);
    assert.match(args.history.at(-1).content, /N42Y/);
    return 'N42Y, runway 25L, cleared for takeoff';
  });
  delete require.cache[require.resolve('../src/radio/radioWorker')];
  delete require.cache[require.resolve('../src/radio/ControllerBrain')];
  const { startRadioWorker, loadStations } = require('../src/radio/radioWorker');
  const { createRadioHub } = require('../monitor/radio');

  const hub = createRadioHub({ workerKey: 'k', logger: { info() {} } });
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => { if (!hub.handleUpgrade(req, socket, head)) socket.destroy(); });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const worker = startRadioWorker({ monitorUrl: `http://127.0.0.1:${port}`, apiKey: 'k', stations: loadStations() });
  try {
    const pilot = new WebSocket(`ws://127.0.0.1:${port}/radio?callsign=N42Y`);
    const inbox = [];
    pilot.on('message', (d, bin) => { if (!bin) inbox.push(JSON.parse(d.toString())); });
    await new Promise((r) => pilot.on('open', r));
    await new Promise((r) => setTimeout(r, 200));
    pilot.send(JSON.stringify({ type: 'tune', tx: '121.000' }));
    pilot.send(JSON.stringify({ type: 'ptt', on: true }));
    await new Promise((r) => setTimeout(r, 50));
    pilot.send(Buffer.alloc(16000 * 2));
    pilot.send(JSON.stringify({ type: 'ptt', on: false }));
    for (let i = 0; i < 50 && !inbox.some((m) => m.type === 'rx-clip'); i++) await new Promise((r) => setTimeout(r, 50));
    const clip = inbox.find((m) => m.type === 'rx-clip');
    assert.ok(clip, 'got a reply');
    assert.strictEqual(clip.from, 'Rockford Tower');
    assert.strictEqual(clip.text, 'N42Y, runway 25L, cleared for takeoff');
    assert.strictEqual(Buffer.from(clip.audio, 'base64').toString(), 'MP3:N42Y, runway 25L, cleared for takeoff');
    assert.ok(inbox.some((m) => m.type === 'rx-text' && /ready for departure/.test(m.text)));
    assert.ok(inbox.find((m) => m.type === 'stations').stations.length >= 55);
    pilot.close();
  } finally {
    worker.stop();
    hub.close();
    server.close();
  }
});
