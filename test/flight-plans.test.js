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
