const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { parseMessage, pickAircraft, toSample, createFeed } = require('../companion/lib/acftFeed');

const entry = { position: { x: -4028, y: 19238 }, heading: 247.4, altitude: 2998.6, speed: 181.2, groundSpeed: 176, isOnGround: false, aircraftType: 'Airbus A320', playerName: 'SomePilot' };

test('both feed shapes are understood, and non-aircraft messages are ignored', () => {
  assert.deepEqual(Object.keys(parseMessage(JSON.stringify({ t: 'ACFT_DATA', d: { N42Y: entry } }))), ['N42Y']);
  assert.deepEqual(Object.keys(parseMessage(JSON.stringify({ type: 'acft', payload: { N42Y: entry } }))), ['N42Y']);
  assert.equal(parseMessage('{"t":"CONTROLLERS","d":[]}'), null);
  assert.equal(parseMessage('not json'), null);
  assert.equal(parseMessage(JSON.stringify({ t: 'ACFT_DATA', d: [1] })), null);
});

test('your aircraft is found by callsign, ignoring case and punctuation, or by player name', () => {
  const all = { 'DLH-123': entry, OTHER: { ...entry, playerName: 'Me' } };
  assert.equal(pickAircraft(all, 'dlh123').callsign, 'DLH-123');
  assert.equal(pickAircraft(all, 'me').callsign, 'OTHER');
  assert.equal(pickAircraft(all, 'NOPE'), null);
  assert.equal(pickAircraft(all, ''), null);
});

test('an entry becomes a sample with rounded numbers, or nothing without a position', () => {
  const s = toSample({ callsign: 'N42Y', ...entry }, 1000);
  assert.deepEqual({ x: s.studX, y: s.studY, hdg: s.headingDeg, alt: s.altFt, spd: s.speedKt, at: s.atMs }, { x: -4028, y: 19238, hdg: 247, alt: 2999, spd: 181, at: 1000 });
  assert.equal(toSample({ heading: 90 }), null);
  assert.equal(toSample({ ...entry, heading: 360 }).headingDeg, 0);
  assert.equal(toSample({ ...entry, heading: -10 }).headingDeg, 350);
});

test('the feed reports status and delivers only your aircraft', () => {
  const sockets = [];
  class FakeWS extends EventEmitter { constructor(url) { super(); this.url = url; sockets.push(this); } close() { this.emit('close'); } }
  const samples = [], states = [];
  const feed = createFeed({ url: 'wss://example.test/ws', callsign: 'N42Y', WebSocketImpl: FakeWS, onSample: (s) => samples.push(s), onStatus: (s) => states.push(s.state), now: () => 5 });
  feed.start();
  const ws = sockets[0];
  assert.equal(ws.url, 'wss://example.test/ws');
  ws.emit('open');
  ws.emit('message', JSON.stringify({ t: 'ACFT_DATA', d: { OTHER: entry } }));
  assert.equal(samples.length, 0);
  ws.emit('message', JSON.stringify({ t: 'ACFT_DATA', d: { OTHER: entry, N42Y: entry } }));
  assert.equal(samples.length, 1);
  assert.equal(samples[0].callsign, 'N42Y');
  assert.deepEqual(states, ['waiting', 'tracking']);
  feed.stop();
  assert.equal(states.at(-1), 'stopped');
});
