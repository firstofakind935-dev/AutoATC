// Controller applications: Discord sign-in (faked), one application per account, reviewers only for /review.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { createApplyRouter, validateAnswers, makeSession, readSession, accountCreatedAt } = require('../apply');
const { QUESTIONS, parseGuilds } = require('../apply/config');

const USER = { id: '300000000000000001', username: 'skyhawk', global_name: 'Skyhawk', avatar: null };
const GUILD_A = '1561048151794913450';
const GUILD_B = '1100000000000000002';

function fakeDiscord({ inGuildA = true } = {}) {
  const calls = [];
  const state = { user: USER };
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
  const fetchImpl = async (url, opts = {}) => {
    calls.push(url);
    if (url.endsWith('/oauth2/token')) return json(200, { access_token: 'tok' });
    if (url.endsWith('/oauth2/token/revoke')) return json(200, {});
    if (url.endsWith('/users/@me')) return json(200, state.user);
    if (url.endsWith(`/users/@me/guilds/${GUILD_A}/member`)) return inGuildA ? json(200, { roles: ['900', '901'], joined_at: '2025-01-15T00:00:00Z', nick: null }) : json(404, {});
    if (url.endsWith(`/users/@me/guilds/${GUILD_B}/member`)) return json(404, {});
    if (url.endsWith(`/guilds/${GUILD_A}/roles`)) {
      assert.strictEqual(opts.headers.Authorization, 'Bot bot-token');
      return json(200, [{ id: '900', name: 'Controller', color: 0x1f6b4a, position: 5 }, { id: '901', name: 'Member', color: 0, position: 1 }]);
    }
    return json(500, {});
  };
  return { fetchImpl, calls, state };
}

async function start({ inGuildA } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-'));
  const env = {
    DISCORD_CLIENT_ID: '123', DISCORD_CLIENT_SECRET: 'sec', APPLY_BOT_TOKEN: 'bot-token', APPLY_SESSION_SECRET: 's3cret',
    APPLY_GUILDS: `${GUILD_A}:AutoATC:required,${GUILD_B}:PTFS`, APPLY_ADMIN_IDS: '300000000000000009', APPLY_DATA_DIR: dir,
    APPLY_PUBLIC_URL: 'http://localhost',
  };
  const d = fakeDiscord({ inGuildA });
  const app = express();
  app.use(express.json());
  app.use('/apply', createApplyRouter({ env, fetchImpl: d.fetchImpl, log: { warn() {}, info() {} } }));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, server, dir, discord: d };
}

async function signIn(base) {
  const login = await fetch(`${base}/apply/login`, { redirect: 'manual' });
  assert.strictEqual(login.status, 302);
  const auth = new URL(login.headers.get('location'));
  assert.strictEqual(auth.searchParams.get('scope'), 'identify guilds.members.read');
  const stateCookie = login.headers.get('set-cookie').split(';')[0];
  const cb = await fetch(`${base}/apply/callback?code=abc&state=${auth.searchParams.get('state')}`, { headers: { cookie: stateCookie }, redirect: 'manual' });
  assert.strictEqual(cb.status, 302);
  const sid = cb.headers.getSetCookie().find((c) => c.startsWith('apply_sid=')).split(';')[0];
  return sid;
}

function goodAnswers() {
  const a = {};
  for (const q of QUESTIONS) {
    if (q.type === 'rank') a[q.id] = q.options.slice(0, q.picks);
    else if (q.type === 'select') a[q.id] = q.options[0];
    else a[q.id] = 'answer';
  }
  return a;
}

test('sign in reads roles and join date, apply once, a second application is refused', async () => {
  const { base, server, dir } = await start();
  try {
    const sid = await signIn(base);
    const me = await (await fetch(`${base}/apply/api/me`, { headers: { cookie: sid } })).json();
    assert.strictEqual(me.signedIn, true);
    assert.strictEqual(me.profile.username, 'skyhawk');
    const [a, b] = me.profile.guilds;
    assert.strictEqual(a.member, true);
    assert.strictEqual(a.joinedAt, '2025-01-15T00:00:00Z');
    assert.deepStrictEqual(a.roles.map((r) => r.name), ['Controller', 'Member']); // highest role first
    assert.strictEqual(b.member, false);
    assert.deepStrictEqual(me.missing, []);

    const post = (body) => fetch(`${base}/apply/api/submit`, { method: 'POST', headers: { cookie: sid, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.strictEqual((await post({ answers: {} })).status, 400);
    assert.strictEqual((await post({ answers: goodAnswers() })).status, 201);
    const again = await post({ answers: goodAnswers() });
    assert.strictEqual(again.status, 409);

    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'applications.json'), 'utf8'));
    assert.strictEqual(saved.applications[USER.id].discord.guilds[0].roles[0].name, 'Controller');
    assert.strictEqual(saved.applications[USER.id].status, 'new');

    // not a reviewer
    assert.strictEqual((await fetch(`${base}/apply/api/admin/applications`, { headers: { cookie: sid } })).status, 403);
    assert.strictEqual((await fetch(`${base}/apply/api/admin/applications`)).status, 401);
    // a reviewer can see, update and reset it
    const admin = `apply_sid=${makeSession('s3cret', '300000000000000009')}`;
    const list = await (await fetch(`${base}/apply/api/admin/applications`, { headers: { cookie: admin } })).json();
    assert.strictEqual(list.applications.length, 1);
    const upd = await fetch(`${base}/apply/api/admin/applications/${USER.id}`, { method: 'POST', headers: { cookie: admin, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'accepted', note: 'good' }) });
    assert.strictEqual((await upd.json()).status, 'accepted');
    const bad = await fetch(`${base}/apply/api/admin/applications/${USER.id}`, { method: 'POST', headers: { cookie: admin, 'Content-Type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ status: 'rejected' }) });
    assert.strictEqual(bad.status, 403);
    assert.strictEqual((await fetch(`${base}/apply/api/admin/applications/${USER.id}`, { method: 'DELETE', headers: { cookie: admin } })).status, 204);
    assert.strictEqual((await post({ answers: goodAnswers() })).status, 201); // reset lets them apply again
  } finally { server.close(); }
});

test('not in a required server: cannot apply', async () => {
  const { base, server } = await start({ inGuildA: false });
  try {
    const sid = await signIn(base);
    const me = await (await fetch(`${base}/apply/api/me`, { headers: { cookie: sid } })).json();
    assert.deepStrictEqual(me.missing, ['AutoATC']);
    const r = await fetch(`${base}/apply/api/submit`, { method: 'POST', headers: { cookie: sid, 'Content-Type': 'application/json' }, body: JSON.stringify({ answers: goodAnswers() }) });
    assert.strictEqual(r.status, 403);
  } finally { server.close(); }
});

test('a forged or wrong-state callback does not sign in', async () => {
  const { base, server } = await start();
  try {
    const cb = await fetch(`${base}/apply/callback?code=abc&state=forged`, { headers: { cookie: 'apply_state=real.' }, redirect: 'manual' });
    assert.strictEqual(cb.headers.get('location'), '/apply/?signin=failed');
    assert.ok(!(cb.headers.getSetCookie() || []).some((c) => c.startsWith('apply_sid=') && !c.startsWith('apply_sid=;')));
    assert.strictEqual(readSession('s3cret', makeSession('other', '1')), null);
    const forged = makeSession('s3cret', '1').replace(/^[^.]+/, Buffer.from(JSON.stringify({ uid: '2', exp: Date.now() + 1e9 })).toString('base64url'));
    assert.strictEqual(readSession('s3cret', forged), null);
  } finally { server.close(); }
});

test('answers are checked against the questions', () => {
  assert.ok(validateAnswers(goodAnswers()).answers);
  const dup = goodAnswers(); const rank = QUESTIONS.find((q) => q.type === 'rank'); dup[rank.id] = [rank.options[0], rank.options[0], rank.options[1]];
  assert.match(validateAnswers(dup).error, /only once/);
  const off = goodAnswers(); const sel = QUESTIONS.find((q) => q.type === 'select'); off[sel.id] = 'Maybe?';
  assert.match(validateAnswers(off).error, /pick one/);
  const long = goodAnswers(); long.roblox = 'x'.repeat(500);
  assert.match(validateAnswers(long).error, /too long/);
});

test('config and helpers', () => {
  assert.deepStrictEqual(parseGuilds(`${GUILD_A}:AutoATC:required, bad:x ,${GUILD_B}`), [
    { id: GUILD_A, name: 'AutoATC', required: true }, { id: GUILD_B, name: `Server ${GUILD_B}`, required: false }]);
  assert.strictEqual(accountCreatedAt('175928847299117063'), '2016-04-30T11:18:25.796Z'); // Discord's documented example
});

test('reviewers give positions (one person each), publish the roster, export CSV', async () => {
  const { base, server, discord } = await start();
  try {
    const sid = await signIn(base);
    const answers = goodAnswers(); answers.roblox = '=HYPERLINK("x")';
    await fetch(`${base}/apply/api/submit`, { method: 'POST', headers: { cookie: sid, 'Content-Type': 'application/json' }, body: JSON.stringify({ answers }) });
    const admin = `apply_sid=${makeSession('s3cret', '300000000000000009')}`;
    const post = (url, body) => fetch(`${base}${url}`, { method: 'POST', headers: { cookie: admin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    assert.strictEqual((await post(`/apply/api/admin/applications/${USER.id}`, { position: 'nowhere' })).status, 400);
    assert.strictEqual((await post(`/apply/api/admin/applications/${USER.id}`, { position: 'itko', status: 'accepted' })).status, 200);

    // nothing shown to the applicant until the roster is published
    let me = await (await fetch(`${base}/apply/api/me`, { headers: { cookie: sid } })).json();
    assert.strictEqual(me.outcome, null);
    assert.deepStrictEqual(await (await post('/apply/api/admin/roster', { published: true })).json(), { rosterPublished: true });
    me = await (await fetch(`${base}/apply/api/me`, { headers: { cookie: sid } })).json();
    assert.deepStrictEqual(me.outcome, { result: 'position', position: 'Tokyo (ITKO)' });

    // a second applicant can't be given a position someone already has
    discord.state.user = { id: '300000000000000002', username: 'second', global_name: 'Second', avatar: null };
    const sid2 = await signIn(base);
    await fetch(`${base}/apply/api/submit`, { method: 'POST', headers: { cookie: sid2, 'Content-Type': 'application/json' }, body: JSON.stringify({ answers: goodAnswers() }) });
    const taken = await post('/apply/api/admin/applications/300000000000000002', { position: 'itko' });
    assert.strictEqual(taken.status, 409);
    assert.match((await taken.json()).error, /already given to Skyhawk/);
    assert.strictEqual((await post('/apply/api/admin/applications/300000000000000002', { position: 'ipph', status: 'waitlist' })).status, 200);
    me = await (await fetch(`${base}/apply/api/me`, { headers: { cookie: sid2 } })).json();
    assert.deepStrictEqual(me.outcome, { result: 'waitlist' }); // a position only counts once they're accepted

    const list = await (await fetch(`${base}/apply/api/admin/applications`, { headers: { cookie: admin } })).json();
    assert.strictEqual(list.rosterPublished, true);
    assert.strictEqual(list.positions.length, 10);

    const csv = await (await fetch(`${base}/apply/api/admin/export.csv`, { headers: { cookie: admin } })).text();
    assert.ok(csv.includes('"Tokyo (ITKO)"'));
    assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`), 'formula-looking answers are defused');
    assert.ok(csv.includes('"Controller, Member"'));
    assert.strictEqual((await fetch(`${base}/apply/api/admin/export.csv`, { headers: { cookie: sid } })).status, 403);
  } finally { server.close(); }
});
