// Controller applications (/apply): sign in with Discord, answer the interview questions once, and the event team
// reviews them at /apply/review. Sign-in reads the applicant's roles and join date in each configured server
// (scope guilds.members.read) and keeps a snapshot with the application. See config.js for the questions and the
// environment variables.
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { QUESTIONS, loadConfig } = require('./config');
const { createStore } = require('./store');

const API = 'https://discord.com/api/v10';
const DISCORD_EPOCH = 1420070400000n;
const SESSION_DAYS = 7;
const STATUSES = ['new', 'interview', 'accepted', 'waitlist', 'rejected'];

/** When a Discord account was created, from its id (a snowflake). */
function accountCreatedAt(id) {
  try { return new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH)).toISOString(); } catch { return null; }
}

function daysSince(iso, now = Date.now()) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 86400000)) : null;
}

/** Checks one submission against the questions; returns {answers} or {error}. */
function validateAnswers(input, questions = QUESTIONS) {
  const answers = {};
  const body = input && typeof input === 'object' ? input : {};
  for (const q of questions) {
    let v = body[q.id];
    if (q.type === 'rank') {
      const picks = Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : [];
      if (picks.some((p) => !q.options.includes(p))) return { error: `"${q.label}": pick from the list.` };
      if (new Set(picks).size !== picks.length) return { error: `"${q.label}": pick each option only once.` };
      if (picks.length > q.picks) return { error: `"${q.label}": pick at most ${q.picks}.` };
      if (q.required && picks.length < q.picks) return { error: `"${q.label}": pick ${q.picks}.` };
      answers[q.id] = picks;
      continue;
    }
    v = typeof v === 'string' ? v.trim() : '';
    if (q.required && !v) return { error: `"${q.label}" is required.` };
    if (q.type === 'select' && v && !q.options.includes(v)) return { error: `"${q.label}": pick one of the options.` };
    const max = q.max || (q.type === 'textarea' ? 1500 : 200);
    if (v.length > max) return { error: `"${q.label}" is too long (at most ${max} characters).` };
    answers[q.id] = v;
  }
  return { answers };
}

// ---- signed session cookie ---------------------------------------------------------------------------------------
function sign(secret, value) { return crypto.createHmac('sha256', secret).update(value).digest('base64url'); }

function makeSession(secret, uid, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ uid, exp: now + SESSION_DAYS * 86400000 })).toString('base64url');
  return `${payload}.${sign(secret, payload)}`;
}

function readSession(secret, cookie, now = Date.now()) {
  if (!cookie || typeof cookie !== 'string') return null;
  const [payload, mac] = cookie.split('.');
  if (!payload || !mac) return null;
  const want = sign(secret, payload);
  if (want.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(mac))) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return s && typeof s.uid === 'string' && s.exp > now ? s : null;
  } catch { return null; }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// ---- router ------------------------------------------------------------------------------------------------------
function createApplyRouter({ env = process.env, fetchImpl = globalThis.fetch, log = console } = {}) {
  const cfg = loadConfig(env);
  const store = createStore(cfg.dataDir);
  // without a configured secret, sessions only last until the next restart (fine for testing; set one on Railway)
  const secret = cfg.sessionSecret || crypto.randomBytes(32).toString('hex');
  const redirectUri = `${cfg.publicUrl}/apply/callback`;
  const secure = cfg.publicUrl.startsWith('https://');
  const profiles = new Map(); // uid -> Discord snapshot from the latest sign-in (memory only)
  const roleCache = new Map(); // guild id -> {at, roles: Map(id -> {name, color, position})}
  const configured = !!(cfg.clientId && cfg.clientSecret);
  if (!configured) log.warn('[apply] DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET not set - /apply sign-in is disabled');
  if (!store.persistent) log.warn(`[apply] no volume (RAILWAY_VOLUME_MOUNT_PATH / APPLY_DATA_DIR): applications are kept in ${store.file} and lost on redeploy`);

  const router = express.Router();

  function setCookie(res, name, value, maxAgeSec) {
    res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/apply; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`);
  }
  function sessionOf(req) { return readSession(secret, parseCookies(req.get('cookie')).apply_sid); }
  const isAdmin = (uid) => cfg.admins.includes(uid);

  // state-changing requests must come from our own pages
  function sameOrigin(req, res, next) {
    const origin = req.get('origin');
    if (origin && origin !== cfg.publicUrl && origin !== `${req.protocol}://${req.get('host')}`) return res.status(403).json({ error: 'bad origin' });
    next();
  }

  async function discord(pathname, auth) {
    const r = await fetchImpl(`${API}${pathname}`, { headers: { Authorization: auth } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`Discord ${pathname} -> ${r.status}`);
    return r.json();
  }

  async function roleNames(guildId) {
    if (!cfg.botToken) return null;
    const hit = roleCache.get(guildId);
    if (hit && Date.now() - hit.at < 10 * 60000) return hit.roles;
    try {
      const list = await discord(`/guilds/${guildId}/roles`, `Bot ${cfg.botToken}`);
      const roles = new Map((list || []).map((r) => [r.id, { name: r.name, color: r.color, position: r.position }]));
      roleCache.set(guildId, { at: Date.now(), roles });
      return roles;
    } catch (e) {
      log.warn(`[apply] role names for ${guildId}: ${e.message}`);
      return null;
    }
  }

  /** The applicant's Discord account plus membership (roles, join date) in each configured server. */
  async function snapshot(accessToken) {
    const bearer = `Bearer ${accessToken}`;
    const user = await discord('/users/@me', bearer);
    const guilds = [];
    for (const g of cfg.guilds) {
      let member = null;
      try { member = await discord(`/users/@me/guilds/${g.id}/member`, bearer); } catch (e) { log.warn(`[apply] member ${g.id}: ${e.message}`); }
      const names = member ? await roleNames(g.id) : null;
      guilds.push({
        id: g.id,
        name: g.name,
        required: g.required,
        member: !!member,
        nick: member?.nick || null,
        joinedAt: member?.joined_at || null,
        roles: (member?.roles || []).map((id) => {
          const r = names?.get(id);
          return { id, name: r ? r.name : null, color: r ? r.color : 0, position: r ? r.position : 0 };
        }).sort((a, b) => b.position - a.position),
      });
    }
    return {
      id: user.id,
      username: user.username,
      displayName: user.global_name || user.username,
      avatar: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128` : null,
      createdAt: accountCreatedAt(user.id),
      guilds,
      fetchedAt: new Date().toISOString(),
    };
  }

  const missingRequired = (p) => p.guilds.filter((g) => g.required && !g.member).map((g) => g.name);

  // ---- pages
  router.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
  router.get('/review', (req, res) => res.sendFile(path.join(__dirname, 'public', 'review.html')));
  router.use('/static', express.static(path.join(__dirname, 'public')));

  // ---- Discord sign-in
  router.get('/login', (req, res) => {
    if (!configured) return res.status(503).send('Discord sign-in is not set up yet.');
    const state = crypto.randomBytes(16).toString('base64url');
    const next = req.query.next === 'review' ? 'review' : '';
    setCookie(res, 'apply_state', `${state}.${next}`, 600);
    const u = new URL('https://discord.com/oauth2/authorize');
    u.searchParams.set('client_id', cfg.clientId);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('scope', 'identify guilds.members.read');
    u.searchParams.set('state', state);
    res.redirect(u.toString());
  });

  router.get('/callback', async (req, res) => {
    const [state, next] = String(parseCookies(req.get('cookie')).apply_state || '').split('.');
    setCookie(res, 'apply_state', '', 0);
    if (req.query.error) return res.redirect('/apply/?signin=cancelled');
    if (!state || req.query.state !== state || typeof req.query.code !== 'string') return res.redirect('/apply/?signin=failed');
    try {
      const tr = await fetchImpl(`${API}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: 'authorization_code', code: req.query.code, redirect_uri: redirectUri }),
      });
      if (!tr.ok) throw new Error(`token exchange -> ${tr.status}`);
      const token = await tr.json();
      const profile = await snapshot(token.access_token);
      // we only needed the token for this one read
      fetchImpl(`${API}/oauth2/token/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, token: token.access_token }),
      }).catch(() => {});
      profiles.set(profile.id, profile);
      setCookie(res, 'apply_sid', makeSession(secret, profile.id), SESSION_DAYS * 86400);
      res.redirect(next === 'review' ? '/apply/review' : '/apply/');
    } catch (e) {
      log.warn(`[apply] sign-in failed: ${e.message}`);
      res.redirect('/apply/?signin=failed');
    }
  });

  router.post('/logout', sameOrigin, (req, res) => {
    setCookie(res, 'apply_sid', '', 0);
    res.status(204).end();
  });

  // ---- applicant API
  router.get('/api/me', (req, res) => {
    const s = sessionOf(req);
    const base = { open: cfg.open, configured, questions: QUESTIONS };
    if (!s) return res.json({ ...base, signedIn: false });
    const profile = profiles.get(s.uid) || null;
    const application = store.get(s.uid);
    res.json({
      ...base,
      signedIn: true,
      needsRefresh: !profile, // the server restarted since sign-in: sign in again to re-read roles
      admin: isAdmin(s.uid),
      profile,
      missing: profile ? missingRequired(profile) : [],
      application: application ? { submittedAt: application.submittedAt, answers: application.answers } : null,
    });
  });

  router.post('/api/submit', sameOrigin, (req, res) => {
    const s = sessionOf(req);
    if (!s) return res.status(401).json({ error: 'Sign in with Discord first.' });
    if (!cfg.open) return res.status(403).json({ error: 'Applications are closed.' });
    if (store.get(s.uid)) return res.status(409).json({ error: 'You have already applied. Each Discord account can apply once.' });
    const profile = profiles.get(s.uid);
    if (!profile) return res.status(401).json({ error: 'Your sign-in expired. Sign in with Discord again.' });
    const missing = missingRequired(profile);
    if (missing.length) return res.status(403).json({ error: `You need to be in ${missing.join(' and ')} to apply.` });
    const v = validateAnswers(req.body && req.body.answers);
    if (v.error) return res.status(400).json({ error: v.error });
    const ok = store.create(s.uid, {
      uid: s.uid,
      discord: profile,
      answers: v.answers,
      submittedAt: new Date().toISOString(),
      status: 'new',
      note: '',
    });
    if (!ok) return res.status(409).json({ error: 'You have already applied. Each Discord account can apply once.' });
    log.info(`[apply] application from ${profile.username} (${s.uid})`);
    res.status(201).json({ ok: true });
  });

  // ---- review API (APPLY_ADMIN_IDS only)
  function requireAdmin(req, res, next) {
    const s = sessionOf(req);
    if (!s) return res.status(401).json({ error: 'Sign in with Discord first.' });
    if (!isAdmin(s.uid)) return res.status(403).json({ error: 'Your Discord account is not on the reviewer list.' });
    req.uid = s.uid;
    next();
  }

  router.get('/api/admin/applications', requireAdmin, (req, res) => {
    res.json({ questions: QUESTIONS, statuses: STATUSES, persistent: store.persistent, applications: store.list() });
  });

  router.post('/api/admin/applications/:uid', sameOrigin, requireAdmin, (req, res) => {
    const patch = {};
    const { status, note } = req.body || {};
    if (status !== undefined) {
      if (!STATUSES.includes(status)) return res.status(400).json({ error: 'unknown status' });
      patch.status = status;
    }
    if (note !== undefined) {
      if (typeof note !== 'string' || note.length > 2000) return res.status(400).json({ error: 'note must be text up to 2000 characters' });
      patch.note = note;
    }
    patch.reviewedBy = req.uid;
    patch.reviewedAt = new Date().toISOString();
    const a = store.update(req.params.uid, patch);
    if (!a) return res.status(404).json({ error: 'no such application' });
    res.json(a);
  });

  // lets that person apply again (e.g. they made a mistake)
  router.delete('/api/admin/applications/:uid', sameOrigin, requireAdmin, (req, res) => {
    if (!store.remove(req.params.uid)) return res.status(404).json({ error: 'no such application' });
    res.status(204).end();
  });

  return router;
}

module.exports = { createApplyRouter, validateAnswers, makeSession, readSession, accountCreatedAt, daysSince };
