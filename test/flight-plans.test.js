// Event flight plans: filed on /fpl, one per callsign, own squawk, radar vectors; the AI sees them in its context.
const test = require('node:test');
const assert = require('node:assert');
const { createFlightPlans, validate } = require('../monitor/flightPlans');

test('filing, updating with the token, refusing someone else\'s callsign, cancelling', () => {
  const s = createFlightPlans();
  const a = s.file({ callsign: 'dal 123', aircraft: 'b738', dep: 'irfd', arr: 'itko' }, '');
  assert.strictEqual(a.status, 201);
  assert.deepStrictEqual([a.plan.callsign, a.plan.aircraft, a.plan.dep, a.plan.arr, a.plan.route], ['DAL123', 'B738', 'IRFD', 'ITKO', 'RADAR VECTORS']);
  assert.match(a.plan.squawk, /^[2-6][0-7]{3}$/);
  assert.strictEqual(a.plan.token, undefined, 'the edit token is never in the public plan');

  assert.strictEqual(s.file({ callsign: 'DAL123', aircraft: 'A320', dep: 'IRFD', arr: 'IMLR' }, 'wrong').status, 409);
  const upd = s.file({ callsign: 'DAL123', aircraft: 'A320', dep: 'IRFD', arr: 'IMLR' }, a.token);
  assert.strictEqual(upd.status, 200);
  assert.strictEqual(upd.plan.arr, 'IMLR');
  assert.strictEqual(upd.plan.squawk, a.plan.squawk, 'keeps its squawk');

  const b = s.file({ callsign: 'N42Y', aircraft: 'C172', dep: 'IMLR', arr: 'IRFD' }, '');
  assert.notStrictEqual(b.plan.squawk, a.plan.squawk);
  assert.deepStrictEqual(s.list().map((p) => p.callsign).sort(), ['DAL123', 'N42Y']);
  assert.ok(s.list().every((p) => p.token === undefined));

  assert.strictEqual(s.cancel('DAL123', 'nope').status, 403);
  assert.strictEqual(s.cancel('DAL123', a.token).status, 204);
  assert.deepStrictEqual(s.list().map((p) => p.callsign), ['N42Y']);
});

test('bad input is refused with a reason; old plans expire', () => {
  assert.match(validate({ callsign: '<b>', aircraft: 'A320', dep: 'IRFD', arr: 'ITKO' }).error, /Callsign/);
  assert.match(validate({ callsign: 'DAL1', aircraft: '', dep: 'IRFD', arr: 'ITKO' }).error, /Aircraft/);
  assert.match(validate({ callsign: 'DAL1', aircraft: 'A320', dep: 'Rockford', arr: 'ITKO' }).error, /Departure/);
  let t = Date.parse('2026-10-31T18:00:00Z');
  const s = createFlightPlans({ now: () => t });
  s.file({ callsign: 'DAL1', aircraft: 'A320', dep: 'IRFD', arr: 'ITKO' }, '');
  t += 13 * 3600 * 1000;
  assert.strictEqual(s.list().length, 0);
});

test('the AI gets the event plans (and still works when flightradar365 is down)', async (t) => {
  const saved = { ...process.env };
  process.env.MONITOR_URL = 'http://monitor.test';
  process.env.FLIGHTRADAR365_BOT_KEY = 'broken';
  t.after(() => { process.env = saved; });
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).startsWith('http://monitor.test/api/flightplans')) {
      return { ok: true, json: async () => ({ plans: [{ callsign: 'DAL123', aircraft: 'B738', dep: 'IRFD', arr: 'ITKO', route: 'RADAR VECTORS', squawk: '4521' }] }) };
    }
    return { ok: false, status: 401, text: async () => 'Unauthorized' };
  });
  delete require.cache[require.resolve('../src/flightplans/store')];
  const { getFlightPlanContext } = require('../src/flightplans/store');
  const ctx = await getFlightPlanContext();
  assert.match(ctx, /DAL123, B738, IFR, IRFD to ITKO, squawk 4521, route: radar vectors/);
  assert.match(ctx, /via radar vectors/);
});

test('with Discord sign-in: filing needs it, plans belong to the account, flights are counted per pilot', async () => {
  const express = require('../monitor/node_modules/express');
  const { createFlightPlanRouter } = require('../monitor/flightPlans');
  const { createDiscordLogin } = require('../monitor/discordLogin');
  const login = createDiscordLogin({ env: { DISCORD_CLIENT_ID: '1', DISCORD_CLIENT_SECRET: '2', SESSION_SECRET: 's' }, log: { warn() {} } });
  const store = createFlightPlans();
  const app = express();
  app.use(express.json());
  app.use('/api/flightplans', createFlightPlanRouter(store, { login }));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/flightplans`;
  const as = (user) => ({ 'Content-Type': 'application/json', cookie: `atc_sid=${login.makeSession(user)}` });
  const amy = { id: '111', name: 'Amy' }, bob = { id: '222', name: 'Bob' };
  const post = (headers, body) => fetch(base, { method: 'POST', headers, body: JSON.stringify(body) });
  try {
    assert.strictEqual((await post({ 'Content-Type': 'application/json' }, { callsign: 'DAL1', aircraft: 'A320', dep: 'IRFD', arr: 'ITKO' })).status, 401);
    assert.strictEqual((await post(as(amy), { callsign: 'DAL1', aircraft: 'A320', dep: 'IRFD', arr: 'ITKO' })).status, 201);
    assert.strictEqual((await post(as(bob), { callsign: 'DAL1', aircraft: 'B738', dep: 'IRFD', arr: 'IMLR' })).status, 409, "Bob can't take Amy's plan");
    assert.strictEqual((await post(as(amy), { callsign: 'DAL1', aircraft: 'A321', dep: 'IRFD', arr: 'ITKO' })).status, 200, 'Amy updates hers (not a new flight)');
    assert.strictEqual((await post(as(amy), { callsign: 'DAL2', aircraft: 'A320', dep: 'ITKO', arr: 'IRFD' })).status, 201);
    assert.strictEqual((await post(as(bob), { callsign: 'N42Y', aircraft: 'C172', dep: 'IMLR', arr: 'IRFD' })).status, 201);
    const listed = await (await fetch(base, { headers: as(amy) })).json();
    assert.deepStrictEqual(listed.mine.sort(), ['DAL1', 'DAL2']);
    assert.strictEqual(listed.plans.find((p) => p.callsign === 'N42Y').filedBy, 'Bob');
    assert.ok(!JSON.stringify(listed.plans).includes('111'), 'Discord ids are not published');
    let board = (await (await fetch(`${base}/leaderboard`)).json()).pilots;
    assert.deepStrictEqual(board.map((p) => [p.name, p.flights]), [['Amy', 2], ['Bob', 1]]);
    // Bob can't cancel Amy's plan; Amy cancelling one takes it off her count
    assert.strictEqual((await fetch(`${base}/DAL2`, { method: 'DELETE', headers: as(bob) })).status, 403);
    assert.strictEqual((await fetch(`${base}/DAL2`, { method: 'DELETE', headers: as(amy) })).status, 204);
    board = (await (await fetch(`${base}/leaderboard`)).json()).pilots;
    assert.deepStrictEqual(board.map((p) => [p.name, p.flights]), [['Bob', 1], ['Amy', 1]]); // a tie goes to the latest flight
  } finally { server.close(); }
});

test('admins close any plan with the admin key; a closed flight still counts', async () => {
  const express = require('../monitor/node_modules/express');
  const { createFlightPlanRouter } = require('../monitor/flightPlans');
  const { createDiscordLogin } = require('../monitor/discordLogin');
  const login = createDiscordLogin({ env: { DISCORD_CLIENT_ID: '1', DISCORD_CLIENT_SECRET: '2', SESSION_SECRET: 's' }, log: { warn() {} } });
  const store = createFlightPlans();
  const app = express();
  app.use(express.json());
  app.use('/api/flightplans', createFlightPlanRouter(store, { login, adminKey: 'ak' }));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/flightplans`;
  try {
    await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: `atc_sid=${login.makeSession({ id: '1', name: 'Amy' })}` }, body: JSON.stringify({ callsign: 'DAL1', aircraft: 'A320', dep: 'IRFD', arr: 'ITKO' }) });
    assert.strictEqual((await fetch(`${base}/DAL1/close`, { method: 'POST' })).status, 403);
    assert.strictEqual((await fetch(`${base}/DAL1/close`, { method: 'POST', headers: { 'x-admin-key': 'nope' } })).status, 403);
    assert.strictEqual((await fetch(`${base}/DAL1/close`, { method: 'POST', headers: { 'x-admin-key': 'ak' } })).status, 204);
    assert.strictEqual((await (await fetch(base)).json()).plans.length, 0);
    assert.deepStrictEqual((await (await fetch(`${base}/leaderboard`)).json()).pilots.map((p) => [p.name, p.flights]), [['Amy', 1]]);
    assert.strictEqual((await fetch(`${base}/DAL1/close`, { method: 'POST', headers: { 'x-admin-key': 'ak' } })).status, 404);
  } finally { server.close(); }
});

test('admins close and reopen filing; filed plans stay and can still be cancelled', async () => {
  const express = require('../monitor/node_modules/express');
  const { createFlightPlanRouter } = require('../monitor/flightPlans');
  const store = createFlightPlans();
  const app = express();
  app.use(express.json());
  app.use('/api/flightplans', createFlightPlanRouter(store, { adminKey: 'ak' }));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/flightplans`;
  const file = (callsign, token = '') => fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-plan-token': token }, body: JSON.stringify({ callsign, aircraft: 'A320', dep: 'IRFD', arr: 'ITKO' }) });
  const filing = (open, key = 'ak') => fetch(`${base}/filing`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-key': key }, body: JSON.stringify({ open }) });
  try {
    const { token } = await (await file('DAL1')).json();
    assert.strictEqual((await filing(false, 'nope')).status, 403);
    assert.deepStrictEqual(await (await filing(false)).json(), { filingOpen: false });
    assert.strictEqual((await (await fetch(base)).json()).filingOpen, false);
    const refused = await file('DAL2');
    assert.strictEqual(refused.status, 403);
    assert.match((await refused.json()).error, /closed/);
    assert.strictEqual((await fetch(`${base}/DAL1`, { method: 'DELETE', headers: { 'x-plan-token': token } })).status, 204, 'cancelling still works');
    await filing(true);
    assert.strictEqual((await file('DAL2')).status, 201);
  } finally { server.close(); }
});
