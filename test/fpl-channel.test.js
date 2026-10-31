// Flight plans posted in the Discord flight-plan channel: Bot Manager reads them, files them on the monitor for the
// poster (they count on the flights-per-pilot board) and replies with the squawk; deleting the message cancels it.
const test = require('node:test');
const assert = require('node:assert');
const { parseFlightPlanMessage } = require('../src/botmanager/flightPlanMessage');

test('reads the usual ways people write a flight plan', () => {
  const want = { callsign: 'DAL123', aircraft: 'B738', dep: 'IRFD', arr: 'ITKO' };
  const norm = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v).toUpperCase()]));
  assert.deepStrictEqual(norm(parseFlightPlanMessage('**Callsign:** DAL123\n**Aircraft:** B738\n**Departure:** IRFD\n**Arrival:** ITKO')), want);
  assert.deepStrictEqual(norm(parseFlightPlanMessage('DAL123 B738 IRFD-ITKO')), want);
  assert.deepStrictEqual(norm(parseFlightPlanMessage('cs: dal123 / type: b738 / from: irfd / to: itko')), want);
  assert.strictEqual(parseFlightPlanMessage('Departing: Greater Rockford').dep, 'Greater Rockford'); // names resolve on the monitor
  // the event's own channel format
  const event = parseFlightPlanMessage('Discord:ryaaneo\nCallsign: Channex 961\nAircraft: A320\nGate: 10\nDeparting: IRFD\nArriving: IPPH\nFlight rules: IFR\nRoute: GPS Direct\nexample flight plan');
  assert.deepStrictEqual(event, { callsign: 'Channex 961', aircraft: 'A320', gate: '10', dep: 'IRFD', arr: 'IPPH', rules: 'IFR', filedRoute: 'GPS Direct' });
  const chat = parseFlightPlanMessage('anyone flying to tokyo tonight?');
  assert.ok(['callsign', 'aircraft', 'dep', 'arr'].filter((k) => chat[k]).length < 2, 'chat is not a flight plan');
});

test('Bot Manager files a channel post for its author, replies with the squawk, and a delete cancels it', async (t) => {
  const express = require('../monitor/node_modules/express');
  const { createFlightPlans, createFlightPlanRouter } = require('../monitor/flightPlans');
  const store = createFlightPlans();
  const app = express();
  app.use(express.json());
  app.use('/api/flightplans', createFlightPlanRouter(store, { botAuth: (req) => req.get('authorization') === 'Bearer k' }));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const saved = { ...process.env };
  process.env.MONITOR_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.MONITOR_API_KEY = 'k';
  process.env.FPL_CHANNEL_ID = '1537904841358311524';
  t.after(() => { process.env = saved; server.close(); });
  delete require.cache[require.resolve('../src/bot/BotManagerBot')];
  const { BotManagerBot } = require('../src/bot/BotManagerBot');
  const bot = new BotManagerBot({ name: 'Bot Manager', token: 'x', guildId: '1' }, []);
  const msg = (content, id = 'm1', channelId = '1537904841358311524') => {
    const m = { id, content, channelId, createdTimestamp: Date.parse('2026-10-31T22:00:00Z'), author: { id: '300000000000000001', username: 'skyhawk', bot: false }, member: { displayName: 'Skyhawk' }, replies: [], reactions: [] };
    m.reply = async (r) => { m.replies.push(r.content); };
    m.react = async (e) => { m.reactions.push(e); };
    return m;
  };
  try {
    const a = msg('Callsign: DAL123\nAircraft: B738\nDeparture: Greater Rockford\nArrival: Tokyo');
    await bot._onFlightPlanMessage(a);
    assert.deepStrictEqual(a.reactions, ['✅']);
    assert.match(a.replies[0], /\*\*DAL123\*\* filed: IRFD → ITKO, B738.*Squawk \*\*\d{4}\*\*/s);
    assert.deepStrictEqual(store.leaderboard().map((p) => [p.name, p.flights]), [['Skyhawk', 1]]);

    const ev = msg('Discord:ryaaneo\nCallsign: Channex 961\nAircraft: A320\nGate: 10\nDeparting: IRFD\nArriving: IPPH\nFlight rules: IFR\nRoute: GPS Direct', 'm7');
    await bot._onFlightPlanMessage(ev);
    assert.match(ev.replies[0], /\*\*CHANNEX961\*\* filed: IRFD → IPPH, A320/);
    const filed = store.list().find((p) => p.callsign === 'CHANNEX961');
    assert.deepStrictEqual([filed.gate, filed.rules, filed.filedRoute, filed.route], ['10', 'IFR', 'GPS Direct', 'RADAR VECTORS']);
    await bot._onFlightPlanDeleted({ id: 'm7' });

    const half = msg('Callsign: N42Y\nAircraft: C172', 'm2');
    await bot._onFlightPlanMessage(half);
    assert.match(half.replies[0], /departure and arrival/);

    const chat = msg('anyone flying to tokyo tonight?', 'm3');
    await bot._onFlightPlanMessage(chat);
    assert.deepStrictEqual(chat.replies, []);

    const early = msg('DAL777 B738 IRFD-ITKO', 'm5');
    early.createdTimestamp = Date.parse('2026-10-30T20:00:00Z');
    await bot._onFlightPlanMessage(early);
    assert.deepStrictEqual(early.replies, [], 'before the event: ignored');
    const late = msg('DAL778 B738 IRFD-ITKO', 'm6');
    late.createdTimestamp = Date.parse('2026-11-02T20:00:00Z');
    await bot._onFlightPlanMessage(late);
    assert.match(late.replies[0], /ended/);
    assert.ok(!store.list().some((p) => /DAL77/.test(p.callsign)));

    const elsewhere = msg('DAL999 B738 IRFD-ITKO', 'm4', '999');
    await bot._onFlightPlanMessage(elsewhere);
    assert.deepStrictEqual(elsewhere.replies, [], 'other channels are ignored');

    await bot._onFlightPlanDeleted({ id: 'm1' });
    assert.strictEqual(store.list().length, 0);
    assert.strictEqual(store.leaderboard().length, 0);
  } finally {
    bot.client.destroy();
  }
});
