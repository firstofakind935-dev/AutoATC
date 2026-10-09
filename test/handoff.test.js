const test = require('node:test');
const assert = require('node:assert/strict');
const { HandoffRegistry } = require('../src/handoff/HandoffRegistry');
const { AtcBot } = require('../src/bot/AtcBot');

const at = (airport, position) => ({ airport, position, callsign: `${airport} ${position}` });

test('a log-on covers only that position by default', () => {
  const r = new HandoffRegistry();
  r.logon({ controllerId: 'u1', controllerName: 'Sam', airport: 'IRFD', position: 'Tower' });
  assert.equal(r.coveringLogon(at('IRFD', 'Tower')).controllerName, 'Sam');
  assert.equal(r.coveringLogon(at('IRFD', 'Ground')), null);
  assert.equal(r.coveringLogon(at('IMLR', 'Tower')), null);
});

test('coverBelow takes every lower position at the same airport, nothing above or elsewhere', () => {
  const r = new HandoffRegistry();
  r.logon({ controllerId: 'u1', controllerName: 'Sam', airport: 'irfd', position: 'Tower', coverBelow: true });
  for (const p of ['Tower', 'Ground', 'Apron', 'Delivery']) assert.ok(r.coveringLogon(at('IRFD', p)), p);
  for (const p of ['Approach', 'Departure', 'Center']) assert.equal(r.coveringLogon(at('IRFD', p)), null, p);
  assert.equal(r.coveringLogon(at('IMLR', 'Ground')), null);
});

test('Approach covering below does not take Departure (same rank)', () => {
  const r = new HandoffRegistry();
  r.logon({ controllerId: 'u1', airport: 'IRFD', position: 'Approach', coverBelow: true });
  assert.equal(r.coveringLogon(at('IRFD', 'Departure')), null);
  assert.ok(r.coveringLogon(at('IRFD', 'Tower')));
});

test('positions outside the hierarchy only match exactly', () => {
  const r = new HandoffRegistry();
  r.logon({ controllerId: 'u1', airport: 'IRFD', position: 'Center', coverBelow: true });
  assert.equal(r.coveringLogon({ airport: null, position: 'Training' }), null);
  assert.equal(r.coveringLogon(at('IRFD', 'Training')), null);
});

test('the controller on the exact position wins over one covering from above', () => {
  const r = new HandoffRegistry();
  r.logon({ controllerId: 'u1', controllerName: 'Center Sam', airport: 'IRFD', position: 'Center', coverBelow: true });
  r.logon({ controllerId: 'u2', controllerName: 'Ground Alex', airport: 'IRFD', position: 'Ground' });
  assert.equal(r.coveringLogon(at('IRFD', 'Ground')).controllerName, 'Ground Alex');
});

test('logging on again moves the controller; logoff clears them and emits change', () => {
  const r = new HandoffRegistry();
  let changes = 0;
  r.on('change', () => changes++);
  r.logon({ controllerId: 'u1', airport: 'IRFD', position: 'Tower' });
  r.logon({ controllerId: 'u1', airport: 'IRFD', position: 'Ground' });
  assert.equal(r.coveringLogon(at('IRFD', 'Tower')), null);
  assert.ok(r.coveringLogon(at('IRFD', 'Ground')));
  assert.equal(r.logoff('u1'), true);
  assert.equal(r.logoff('u1'), false);
  assert.equal(r.coveringLogon(at('IRFD', 'Ground')), null);
  assert.equal(changes, 3);
});

// Drives AtcBot's leave/rejoin logic against fake voice plumbing - no Discord.
function fakeBot(registry, persona) {
  const { HumanHandoff } = require('../src/bot/HumanHandoff');
  const bot = Object.create(AtcBot.prototype);
  const events = [];
  Object.assign(bot, {
    config: { persona },
    handoff: new HumanHandoff(persona, registry),
    standingDownFor: null,
    rejoinPending: false,
    handoffSync: Promise.resolve(),
    logger: { info() {}, warn() {}, error() {} },
    player: { stop: () => events.push('player.stop') },
    capture: { stop: () => events.push('capture.stop') },
    connection: { destroy: () => events.push('destroy') },
    _connectVoice: async () => { events.push('join'); bot.connection = { destroy: () => events.push('destroy') }; },
    _announce: async (text) => events.push(`say: ${text}`),
  });
  registry.on('change', () => bot._queueHandoffSync());
  return { bot, events, settle: () => bot.handoffSync };
}

test('bot leaves on log-on and rejoins on log-off', async () => {
  const r = new HandoffRegistry();
  const { bot, events, settle } = fakeBot(r, at('IRFD', 'Ground'));

  r.logon({ controllerId: 'u1', controllerName: 'Sam', airport: 'IRFD', position: 'Tower', coverBelow: true });
  await settle();
  assert.equal(bot.connection, null);
  assert.ok(events.includes('destroy'));
  assert.ok(events.some((e) => e.includes('Sam is covering from Tower')));

  r.logoff('u1');
  await settle();
  assert.ok(bot.connection);
  assert.equal(events.filter((e) => e === 'join').length, 1);
  assert.ok(events.some((e) => e.includes('Sam logged off. AI ATC back on frequency')));
});

test('handing a position between controllers does not bounce the bot back on frequency', async () => {
  const r = new HandoffRegistry();
  const { events, settle } = fakeBot(r, at('IRFD', 'Tower'));
  r.logon({ controllerId: 'u1', controllerName: 'Sam', airport: 'IRFD', position: 'Tower' });
  r.logon({ controllerId: 'u2', controllerName: 'Alex', airport: 'IRFD', position: 'Tower' });
  r.logoff('u1');
  await settle();
  assert.equal(events.filter((e) => e === 'join').length, 0);
  r.logoff('u2');
  await settle();
  assert.ok(events.some((e) => e.includes('Alex logged off')));
});

test('a log-on elsewhere leaves the bot alone', async () => {
  const r = new HandoffRegistry();
  const { bot, events, settle } = fakeBot(r, at('IRFD', 'Tower'));
  r.logon({ controllerId: 'u1', airport: 'IMLR', position: 'Center', coverBelow: true });
  await settle();
  assert.ok(bot.connection);
  assert.deepEqual(events, []);
});
