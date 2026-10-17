// A bot that isn't in its server yet waits and carries on once it's added, instead of failing for good.
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { fetchGuildWhenAdded, keepTrying } = require('../src/bot/voiceConnect');

const quiet = { info() {}, warn() {}, error() {} };

test('waits through "Unknown Guild" and continues as soon as the bot is added', async () => {
  const client = new EventEmitter();
  let added = false;
  client.guilds = { fetch: async () => { if (!added) throw Object.assign(new Error('Unknown Guild'), { code: 10004 }); return { id: '1' }; } };
  const warnings = [];
  const p = fetchGuildWhenAdded(client, '1', { ...quiet, warn: (m) => warnings.push(m) });
  await new Promise((r) => setTimeout(r, 20));
  added = true;
  client.emit('guildCreate', { id: '1' });
  assert.deepStrictEqual(await p, { id: '1' });
  assert.strictEqual(warnings.length, 1, 'says it once');
});

test('other errors are not swallowed', async () => {
  const client = new EventEmitter();
  client.guilds = { fetch: async () => { throw Object.assign(new Error('Invalid token'), { code: 40001 }); } };
  await assert.rejects(fetchGuildWhenAdded(client, '1', quiet), /Invalid token/);
});

test('keepTrying retries until the join works', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let n = 0;
  const p = keepTrying(async () => { n += 1; if (n < 3) throw new Error('rate limited'); return 'joined'; }, quiet);
  for (let i = 0; i < 5; i++) { await Promise.resolve(); t.mock.timers.tick(60_000); await Promise.resolve(); }
  assert.strictEqual(await p, 'joined');
  assert.strictEqual(n, 3);
});
