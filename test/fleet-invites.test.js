// The monitor learns each bot's application id from its login log line and builds its invite link.
const test = require('node:test');
const assert = require('node:assert');
const { createFleetInvites, inviteUrl, invitePage, PERMISSIONS } = require('../monitor/fleetInvites');

test('a login log line registers the bot; other lines are ignored', () => {
  const f = createFleetInvites();
  f.observe({ bot: 'Rockford Tower', message: 'Logged in as Rockford Tower#1234 (application 1430000000000000001, type atc)', timestamp: 't' });
  f.observe({ bot: 'Bot Manager', message: 'Logged in as Manager#1 (application 1430000000000000002, type botmanager)', timestamp: 't' });
  f.observe({ bot: 'Rockford Tower', message: 'Joined voice channel 123', timestamp: 't' });
  assert.deepStrictEqual(f.list().map((b) => b.name), ['Bot Manager', 'Rockford Tower']); // manager first
  assert.strictEqual(f.list()[1].applicationId, '1430000000000000001');
});

test('invite links: right client, scopes and permissions; the server pre-selected when given', () => {
  const bot = { name: 'X', tag: 'X#1', applicationId: '1430000000000000001', type: 'atc' };
  const u = new URL(inviteUrl(bot, '1561049472564207000'));
  assert.strictEqual(u.searchParams.get('client_id'), '1430000000000000001');
  assert.strictEqual(u.searchParams.get('scope'), 'bot applications.commands');
  assert.strictEqual(u.searchParams.get('guild_id'), '1561049472564207000');
  const perms = BigInt(u.searchParams.get('permissions'));
  for (const bit of [10n, 11n, 20n, 21n]) assert.ok(perms & (1n << bit), `missing permission bit ${bit}`); // view, send, connect, speak
  assert.ok(!(perms & (1n << 3n)), 'never Administrator');
  assert.ok(PERMISSIONS.botmanager & (1n << 24n), 'Bot Manager can move members');
  assert.strictEqual(new URL(inviteUrl(bot)).searchParams.get('guild_id'), null);
});

test('the page escapes names', () => {
  const html = invitePage([{ name: '<b>x</b>', tag: 't', applicationId: '1', type: 'atc' }], null);
  assert.ok(!html.includes('<b>x</b>') && html.includes('&lt;b&gt;x&lt;/b&gt;'));
});
