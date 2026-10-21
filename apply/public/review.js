// Reviewers' page: every application with the applicant's Discord roles and tenure, status and notes.
(function () {
  const $ = (id) => document.getElementById(id);
  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids) if (k) n.append(k);
    return n;
  };
  const days = (iso) => { const d = Math.floor((Date.now() - Date.parse(iso)) / 86400000); return Number.isFinite(d) ? d : null; };
  const ago = (iso) => { const d = days(iso); if (d === null) return ''; return d < 60 ? `${d} days` : d < 730 ? `${Math.floor(d / 30.44)} months` : `${(d / 365.25).toFixed(1)} years`; };
  const date = (iso) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const hex = (c) => (c ? `#${c.toString(16).padStart(6, '0')}` : null);

  let data = null;
  let filter = 'all';
  let justSaved = null; // shows "Saved." on that card after the re-render

  function flash(t) { $('flash').textContent = t; $('flash').hidden = !t; }

  async function api(method, url, body) {
    const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 204) return null;
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || `Request failed (${r.status})`); e.status = r.status; throw e; }
    return j;
  }

  function renderSummary() {
    const counts = { all: data.applications.length };
    for (const s of data.statuses) counts[s] = data.applications.filter((a) => a.status === s).length;
    const chips = $('statusChips');
    chips.replaceChildren();
    for (const s of ['all', ...data.statuses]) {
      const b = el('button', { type: 'button', class: `chip${filter === s ? ' on' : ''}`, 'aria-pressed': String(filter === s), text: `${s} ${counts[s]}` });
      b.addEventListener('click', () => { filter = s; render(); });
      chips.append(b);
    }
    const rankQ = data.questions.find((q) => q.type === 'rank');
    const t = $('tally');
    t.replaceChildren();
    if (!rankQ) return;
    t.append(el('tr', {}, el('th', { text: 'Position' }), el('th', { text: '1st' }), el('th', { text: '2nd' }), el('th', { text: '3rd' })));
    for (const o of rankQ.options) {
      const n = [0, 1, 2].map((i) => data.applications.filter((a) => (a.answers[rankQ.id] || [])[i] === o).length);
      t.append(el('tr', {}, el('td', { text: o }), ...n.map((x) => el('td', { class: 'n', text: String(x) }))));
    }
  }

  const posLabel = (id) => (data.positions.find((p) => p.id === id) || {}).label || '';
  const rankQ = () => data.questions.find((q) => q.type === 'rank');
  const pickRank = (a, id) => { const q = rankQ(); const i = q ? (a.answers[q.id] || []).indexOf(posLabel(id)) : -1; return i + 1; };

  function renderRoster() {
    const t = $('roster');
    t.replaceChildren(el('tr', {}, el('th', { text: 'Position' }), el('th', { text: 'Controller' }), el('th', { text: 'Their pick' }), el('th', { text: 'Status' })));
    let filled = 0;
    for (const p of data.positions) {
      const a = data.applications.find((x) => x.position === p.id);
      if (a) filled++;
      const r = a ? pickRank(a, p.id) : 0;
      t.append(el('tr', {},
        el('td', { text: p.label }),
        el('td', { text: a ? a.discord.displayName : '—' }),
        el('td', { class: 'n', text: a ? (r ? ['1st', '2nd', '3rd'][r - 1] || `${r}th` : 'not picked') : '' }),
        el('td', {}, a ? el('span', { class: `status ${a.status}`, text: a.status }) : el('span', { class: 'hint', text: 'open' }))));
    }
    const unaccepted = data.applications.filter((a) => a.position && a.status !== 'accepted').length;
    $('rosterHint').textContent = `${filled} of ${data.positions.length} positions filled. Rockford Approach + Departure is only needed with a 10th controller.`
      + (unaccepted ? ` ${unaccepted} assigned controller${unaccepted === 1 ? ' is' : 's are'} not marked accepted yet, so they won't see their position.` : '')
      + (data.rosterPublished ? ' Published: applicants can see their result on /apply.' : ' Not published: applicants don\'t see anything yet.');
    $('publish').textContent = data.rosterPublished ? 'Unpublish roster' : 'Publish roster';
  }

  function guildBlock(g) {
    const head = el('div', { class: 'head' }, el('span', { class: 'gname', text: g.name }),
      el('span', { class: 'mono', text: g.member ? `member for ${ago(g.joinedAt)} · since ${date(g.joinedAt)}${g.nick ? ` · nick ${g.nick}` : ''}` : 'not a member' }));
    const roles = el('div', { class: 'roles' });
    for (const r of g.roles || []) {
      const dot = el('i');
      if (hex(r.color)) dot.style.background = hex(r.color);
      roles.append(el('span', { class: 'role' }, dot, document.createTextNode(r.name || `Role ${r.id}`)));
    }
    return el('div', { class: `guild${g.member ? '' : ' out'}` }, head, g.member && g.roles.length ? roles : null);
  }

  function appCard(a) {
    const d = a.discord;
    const avatar = d.avatar ? el('img', { class: 'avatar', src: d.avatar, alt: '' }) : el('div', { class: 'avatar' });
    const fresh = days(d.createdAt);
    const top = el('div', { class: 'top' }, avatar,
      el('div', { style: 'min-width:0' },
        el('h3', { text: d.displayName }),
        el('div', { class: 'mono', text: `@${d.username} · ${d.id} · account ${ago(d.createdAt)} old${fresh !== null && fresh < 90 ? ' (new account)' : ''} · applied ${date(a.submittedAt)}` })),
      el('span', { class: `status ${a.status}`, text: a.status }));

    const answers = el('dl', { class: 'answers' });
    for (const q of data.questions) {
      const v = a.answers[q.id];
      const text = Array.isArray(v) ? v.map((x, i) => `${i + 1}. ${x}`).join('\n') : (v || '—');
      answers.append(el('dt', { text: q.label }), el('dd', { text }));
    }

    const status = el('select', { 'aria-label': `Status for ${d.displayName}` });
    for (const s of data.statuses) status.append(el('option', { value: s, text: s, selected: a.status === s }));
    const pos = el('select', { 'aria-label': `Position for ${d.displayName}` }, el('option', { value: '', text: 'No position' }));
    for (const p of data.positions) {
      const holder = data.applications.find((x) => x.position === p.id && x.uid !== a.uid);
      const r = pickRank(a, p.id);
      pos.append(el('option', { value: p.id, selected: a.position === p.id,
        text: `${p.label}${r ? ` (their ${['1st', '2nd', '3rd'][r - 1] || `${r}th`})` : ''}${holder ? ` · given to ${holder.discord.displayName}` : ''}` }));
    }
    const note = el('textarea', { 'aria-label': `Reviewer notes for ${d.displayName}`, maxlength: 2000, placeholder: 'Notes for the team (applicants never see these)' });
    note.value = a.note || '';
    const msg = el('span', { class: 'note', role: 'status' });
    const save = el('button', { type: 'button', class: 'primary', text: 'Save' });
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        const updated = await api('POST', `/apply/api/admin/applications/${a.uid}`, { status: status.value, note: note.value, position: pos.value || null });
        Object.assign(a, updated);
        justSaved = a.uid;
        render(); // every card's position list and the roster change
        return;
      } catch (e) { msg.className = 'note bad'; msg.textContent = e.message; }
      save.disabled = false;
    });

    const reset = el('button', { type: 'button', text: 'Let them apply again' });
    const confirm = el('div', { class: 'confirm', hidden: true },
      el('span', { text: `Delete ${d.displayName}'s application so they can apply again?` }));
    const yes = el('button', { type: 'button', text: 'Delete application' });
    const no = el('button', { type: 'button', text: 'Keep' });
    confirm.append(yes, no);
    reset.addEventListener('click', () => { confirm.hidden = false; });
    no.addEventListener('click', () => { confirm.hidden = true; });
    yes.addEventListener('click', async () => {
      try {
        await api('DELETE', `/apply/api/admin/applications/${a.uid}`);
        data.applications = data.applications.filter((x) => x.uid !== a.uid);
        render();
      } catch (e) { msg.className = 'note bad'; msg.textContent = e.message; confirm.hidden = true; }
    });

    if (justSaved === a.uid) { msg.textContent = 'Saved.'; justSaved = null; }
    const reviewed = a.reviewedAt ? el('span', { class: 'hint', text: `Last updated ${date(a.reviewedAt)}` }) : null;
    return el('section', { class: 'card app' }, top,
      el('div', { class: 'guilds' }, ...(d.guilds || []).map(guildBlock)),
      el('details', {}, el('summary', { text: 'Answers' }), answers),
      el('div', { class: 'review-row' }, el('div', { style: 'display:grid;gap:8px' }, status, pos), note),
      el('div', { class: 'actions' }, save, reset, msg, reviewed),
      confirm);
  }

  function render() {
    renderSummary();
    renderRoster();
    const q = $('search').value.trim().toLowerCase();
    const firstGuild = (a) => (a.discord.guilds || [])[0];
    let list = data.applications.filter((a) => filter === 'all' || a.status === filter);
    if (q) list = list.filter((a) => [a.discord.displayName, a.discord.username, a.answers.roblox].some((x) => String(x || '').toLowerCase().includes(q)));
    const sort = $('sort').value;
    if (sort === 'newest') list = list.slice().reverse();
    if (sort === 'tenure') list = list.slice().sort((a, b) => String(firstGuild(a)?.joinedAt || '9').localeCompare(String(firstGuild(b)?.joinedAt || '9')));
    const box = $('apps');
    box.replaceChildren(...list.map(appCard));
    if (!list.length) box.append(el('p', { class: 'hint', text: data.applications.length ? 'No applications match.' : 'No applications yet. Share /apply with your controllers.' }));
  }

  async function load() {
    try {
      data = await api('GET', '/apply/api/admin/applications');
    } catch (e) {
      $('signin').hidden = false;
      if (e.status === 403) { $('signinText').textContent = e.message; }
      return;
    }
    if (!data.persistent) flash('Applications are not on a volume yet, so a redeploy erases them. Attach a volume to this service on Railway.');
    $('summary').hidden = false;
    $('rosterCard').hidden = false;
    render();
  }

  // The full roster as a Discord message: every position, with the accepted controller (<@id> pings them) or Open.
  function discordRoster() {
    const accepted = data.applications.filter((a) => a.status === 'accepted');
    const lines = ['**Halloween event controller roster (Server 1)**', ''];
    for (const p of data.positions) {
      const a = accepted.find((x) => x.position === p.id);
      lines.push(`**${p.label}**: ${a ? `<@${a.uid}>` : 'Open'}`);
    }
    const spare = accepted.filter((a) => !a.position);
    if (spare.length) lines.push('', `**Standby**: ${spare.map((a) => `<@${a.uid}>`).join(' ')}`);
    return { text: lines.join('\n'), count: accepted.filter((a) => a.position).length };
  }

  $('copyDiscord').addEventListener('click', async () => {
    const { text, count } = discordRoster();
    const box = $('discordText');
    box.value = text;
    $('discordBox').hidden = false;
    const note = $('copyNote');
    if (!count) { note.className = 'note warn'; note.textContent = 'Nobody is accepted with a position yet: mark people accepted and give them a position first.'; return; }
    try {
      await navigator.clipboard.writeText(text);
      note.className = 'note'; note.textContent = `Copied ${count} controller${count === 1 ? '' : 's'}. Paste it into Discord.`;
    } catch {
      box.focus(); box.select();
      note.className = 'note'; note.textContent = 'Selected: press Ctrl+C (or Cmd+C) to copy.';
    }
  });

  $('publish').addEventListener('click', async () => {
    $('publish').disabled = true;
    try {
      const r = await api('POST', '/apply/api/admin/roster', { published: !data.rosterPublished });
      data.rosterPublished = r.rosterPublished;
      renderRoster();
    } catch (e) { flash(e.message); }
    $('publish').disabled = false;
  });
  $('search').addEventListener('input', render);
  $('sort').addEventListener('change', render);
  load();
})();
