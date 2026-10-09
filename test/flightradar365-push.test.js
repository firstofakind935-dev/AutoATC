const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPayload, createPusher, startFromEnv } = require('../monitor/flightradar365Push');

const row = (callsign, extra = {}) => ({
  callsign, aircraftType: 'A220', speed: 240, ageMs: 100,
  position: { referenceAirport: 'IRFD', distanceNm: 5, bearingDeg: 90, altitudeFt: 4400, headingDeg: 270, squawk: '1234', pilot: 'secret' },
  ...extra,
});

test('payload carries only the whitelisted fields, with x/y on the world grid', () => {
  const { aircraft, replace } = buildPayload([row('N42Y')]);
  assert.equal(replace, true);
  assert.deepEqual(Object.keys(aircraft[0]).sort(), ['altitude', 'callsign', 'ground_speed', 'heading', 'x', 'y']);
  assert.equal(aircraft[0].altitude, 4400);
  assert.equal(aircraft[0].ground_speed, 240);
  assert.equal(aircraft[0].heading, 270);
  assert.equal(typeof aircraft[0].x, 'number');
});

test('callsigns are unique, unplaceable aircraft are skipped, and the 500 limit holds', () => {
  const unplaced = row('LOST'); unplaced.position = { referenceAirport: 'NOPE', distanceNm: 1, bearingDeg: 0 };
  const { aircraft } = buildPayload([row('A1'), row('A1'), unplaced]);
  assert.deepEqual(aircraft.map((a) => a.callsign), ['A1']);
  const many = Array.from({ length: 600 }, (_, i) => row(`C${i}`));
  assert.equal(buildPayload(many).aircraft.length, 500);
});

test('the pusher POSTs with the bot key header and does not log the key', async () => {
  const calls = []; const logs = [];
  const pusher = createPusher({
    getPositions: () => [row('N42Y')], key: 'sekret-key', url: 'https://example.test/track',
    fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true }; },
    log: { warn: (m) => logs.push(m) },
  });
  await pusher.tick();
  assert.equal(calls[0].url, 'https://example.test/track');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['x-bot-key'], 'sekret-key');
  assert.equal(JSON.parse(calls[0].init.body).aircraft[0].callsign, 'N42Y');
  const failing = createPusher({ getPositions: () => [], key: 'sekret-key', fetchImpl: async () => ({ ok: false, status: 401 }), log: { warn: (m) => logs.push(m) } });
  await failing.tick(); await failing.tick();
  assert.equal(logs.length, 1, 'same error is logged once');
  assert.ok(!logs.join('').includes('sekret-key'));
});

test('nothing starts without FR365_BOT_KEY', () => {
  assert.equal(startFromEnv(() => [], {}), null);
});
