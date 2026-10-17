// The fleet's invite links: every bot logs "Logged in as <tag> (application <id>, type <type>)" when it starts
// (src/bot/*.js), and that log line reaches the monitor through /api/ingest like any other. This remembers the
// application id and type per bot, so /invite can list a one-click "add to server" link for each - adding a bot to
// a Discord server always needs a server admin to authorize it; this just saves looking up 60 client ids.

const LOGIN = /^Logged in as (.+?) \(application (\d{15,22}), type (atc|atis|botmanager)\)/;

// Discord permission bits each kind of bot needs.
const PERM = {
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  CONNECT: 1n << 20n,
  SPEAK: 1n << 21n,
  MOVE_MEMBERS: 1n << 24n,
  USE_VAD: 1n << 25n,
  MANAGE_CHANNELS: 1n << 4n,
};
const VOICE = PERM.VIEW_CHANNEL | PERM.SEND_MESSAGES | PERM.READ_MESSAGE_HISTORY | PERM.CONNECT | PERM.SPEAK | PERM.USE_VAD;
const PERMISSIONS = {
  atc: VOICE,
  atis: VOICE,
  // moves pilots between the fleet's channels; Manage Channels lets scripts/create-voice-channels.js run with it
  botmanager: VOICE | PERM.MOVE_MEMBERS | PERM.MANAGE_CHANNELS,
};

function createFleetInvites() {
  const bots = new Map(); // name -> {name, tag, applicationId, type, seenAt}
  return {
    /** Feed every ingested log entry through here. */
    observe(entry) {
      const m = LOGIN.exec(entry.message || '');
      if (!m) return;
      bots.set(entry.bot, { name: entry.bot, tag: m[1], applicationId: m[2], type: m[3], seenAt: entry.timestamp });
    },
    list() {
      return [...bots.values()].sort((a, b) => (a.type === 'botmanager' ? -1 : b.type === 'botmanager' ? 1 : a.name.localeCompare(b.name)));
    },
  };
}

/** The OAuth2 invite link for one bot; with a guild id the server is pre-selected. */
function inviteUrl(bot, guildId) {
  const q = new URLSearchParams({
    client_id: bot.applicationId,
    scope: 'bot applications.commands',
    permissions: String(PERMISSIONS[bot.type] || VOICE),
  });
  if (guildId) {
    q.set('guild_id', guildId);
    q.set('disable_guild_select', 'true');
  }
  return `https://discord.com/oauth2/authorize?${q}`;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function invitePage(list, guildId) {
  const rows = list.map((b, i) => `<tr data-i="${i}"><td>${i + 1}</td><td>${esc(b.name)}<div class="tag">${esc(b.tag)} · ${esc(b.type)}</div></td>`
    + `<td><a class="btn" target="_blank" rel="noopener" href="${esc(inviteUrl(b, guildId))}">Add to server</a></td><td class="done"></td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fleet invites</title><style>
:root{color-scheme:light dark;--bg:#0f1115;--fg:#e8e8ea;--dim:#9aa0aa;--line:#262a33;--accent:#5865f2;--ok:#3ba55d}
@media (prefers-color-scheme:light){:root{--bg:#fafafa;--fg:#16181d;--dim:#5b6170;--line:#e3e5ea}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;margin:0 0 6px}p{color:var(--dim)}
form{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0}input{flex:1;min-width:200px;padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:transparent;color:inherit}
button,.btn{padding:8px 14px;border-radius:6px;border:0;background:var(--accent);color:#fff;text-decoration:none;cursor:pointer;white-space:nowrap;display:inline-block}
table{width:100%;border-collapse:collapse}td{padding:8px 6px;border-top:1px solid var(--line);vertical-align:middle}
td:first-child{color:var(--dim);width:2em}.tag{color:var(--dim);font-size:12px}.done{width:5em;color:var(--ok)}
tr.clicked .btn{background:var(--line);color:var(--dim)}
</style></head><body><main>
<h1>Add the fleet to a server</h1>
<p>${list.length} bot${list.length === 1 ? '' : 's'} have checked in (each bot appears here once it has started and logged in).
Click each <b>Add to server</b>, then <b>Authorize</b> in the Discord tab that opens - Discord needs a server admin to approve every bot.
Clicked rows are marked, so you can keep your place.</p>
<form method="get"><input name="guild" placeholder="Server ID (right-click the server icon - Copy Server ID)" value="${esc(guildId || '')}">
<button>${guildId ? 'Change server' : 'Use this server'}</button></form>
${guildId ? `<p>Links go straight to server <code>${esc(guildId)}</code>.</p>` : '<p>No server ID given: Discord will ask which server for each bot.</p>'}
<table><tbody>${rows || '<tr><td></td><td>No bots have checked in yet. Restart the fleet (redeploy) and reload this page.</td></tr>'}</tbody></table>
<script>
const key = 'invited:' + ${JSON.stringify(guildId || 'any')};
let seen = new Set();
try { seen = new Set(JSON.parse(localStorage.getItem(key) || '[]')); } catch {}
for (const tr of document.querySelectorAll('tr[data-i]')) {
  const name = tr.children[1].firstChild.textContent;
  const mark = () => { tr.classList.add('clicked'); tr.querySelector('.done').textContent = 'clicked'; };
  if (seen.has(name)) mark();
  tr.querySelector('.btn').addEventListener('click', () => { seen.add(name); mark(); try { localStorage.setItem(key, JSON.stringify([...seen])); } catch {} });
}
</script></main></body></html>`;
}

module.exports = { createFleetInvites, inviteUrl, invitePage, PERMISSIONS };
