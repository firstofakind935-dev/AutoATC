// "Sign in with Discord" for the monitor's public pages (the flight plan page, /fpl): who filed what, so flights can be
// counted per person. Scope `identify` only - Discord name and avatar, nothing else. The session is a signed cookie
// (7 days); the Discord token is used once at sign-in and revoked.
//
// Env (cpdlc service): DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, PUBLIC_URL (default https://cpdlc.up.railway.app),
// SESSION_SECRET (any long random text; without it sign-ins last until the next restart).
// Discord Developer Portal -> OAuth2 -> Redirects: <PUBLIC_URL>/auth/discord/callback
const crypto = require('crypto');
const express = require('express');

const API = 'https://discord.com/api/v10';
const SESSION_DAYS = 7;
const COOKIE = 'atc_sid';

function sign(secret, value) { return crypto.createHmac('sha256', secret).update(value).digest('base64url'); }

function makeSession(secret, user, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ ...user, exp: now + SESSION_DAYS * 86400000 })).toString('base64url');
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
    return s && typeof s.id === 'string' && s.exp > now ? s : null;
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

const safeNext = (n) => (typeof n === 'string' && /^\/[a-z0-9/_-]*$/i.test(n) ? n : '/');

function createDiscordLogin({ env = process.env, fetchImpl = globalThis.fetch, log = console } = {}) {
  const clientId = env.DISCORD_CLIENT_ID || '';
  const clientSecret = env.DISCORD_CLIENT_SECRET || '';
  const publicUrl = (env.PUBLIC_URL || 'https://cpdlc.up.railway.app').replace(/\/+$/, '');
  const secret = env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
  const configured = !!(clientId && clientSecret);
  const redirectUri = `${publicUrl}/auth/discord/callback`;
  const secure = publicUrl.startsWith('https://');
  if (!configured) log.warn('[login] DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET not set - Discord sign-in is off');

  const cookie = (res, name, value, maxAge) =>
    res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);

  /** The signed-in Discord user {id, name, avatar} or null. */
  const userOf = (req) => readSession(secret, parseCookies(req.get('cookie'))[COOKIE]);

  const router = express.Router();
  router.get('/login', (req, res) => {
    if (!configured) return res.status(503).send('Discord sign-in is not set up yet.');
    const state = crypto.randomBytes(16).toString('base64url');
    cookie(res, 'atc_state', `${state}|${safeNext(req.query.next)}`, 600);
    const u = new URL('https://discord.com/oauth2/authorize');
    u.searchParams.set('client_id', clientId);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('scope', 'identify');
    u.searchParams.set('state', state);
    res.redirect(u.toString());
  });
  router.get('/callback', async (req, res) => {
    const [state, next] = String(parseCookies(req.get('cookie')).atc_state || '').split('|');
    cookie(res, 'atc_state', '', 0);
    const back = safeNext(next);
    if (req.query.error) return res.redirect(`${back}?signin=cancelled`);
    if (!state || req.query.state !== state || typeof req.query.code !== 'string') return res.redirect(`${back}?signin=failed`);
    try {
      const tr = await fetchImpl(`${API}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code', code: req.query.code, redirect_uri: redirectUri }),
      });
      if (!tr.ok) throw new Error(`token exchange -> ${tr.status}`);
      const token = await tr.json();
      const ur = await fetchImpl(`${API}/users/@me`, { headers: { Authorization: `Bearer ${token.access_token}` } });
      if (!ur.ok) throw new Error(`users/@me -> ${ur.status}`);
      const u = await ur.json();
      fetchImpl(`${API}/oauth2/token/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, token: token.access_token }),
      }).catch(() => {});
      const user = { id: u.id, name: u.global_name || u.username, username: u.username, avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64` : null };
      cookie(res, COOKIE, makeSession(secret, user), SESSION_DAYS * 86400);
      res.redirect(back);
    } catch (e) {
      log.warn(`[login] Discord sign-in failed: ${e.message}`);
      res.redirect(`${back}?signin=failed`);
    }
  });
  router.post('/logout', (req, res) => { cookie(res, COOKIE, '', 0); res.status(204).end(); });
  router.get('/me', (req, res) => {
    const u = userOf(req);
    res.json({ configured, user: u ? { id: u.id, name: u.name, username: u.username, avatar: u.avatar } : null });
  });

  return { router, userOf, configured, makeSession: (user) => makeSession(secret, user) };
}

module.exports = { createDiscordLogin, makeSession, readSession };
