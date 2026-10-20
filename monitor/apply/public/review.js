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
    const note = el('textarea', { 'aria-label': `Reviewer notes for ${d.displayName}`, maxlength: 2000, placeholder: 'Notes for the team (applicants never see these)' });
    note.value = a.note || '';
    const msg = el('span', { class: 'note', role: 'status' });
    const save = el('button', { type: 'button', class: 'primary', text: 'Save' });
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        const updated = await api('POST', `/apply/api/admin/applications/${a.uid}`, { status: status.value, note: note.value });
        Object.assign(a, updated);
        msg.className = 'note'; msg.textContent = 'Saved.';
        renderSummary();
        top.querySelector('.status').className = `status ${a.status}`;
        top.querySelector('.status').textContent = a.status;
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

    const reviewed = a.reviewedAt ? el('span', { class: 'hint', text: `Last updated ${date(a.reviewedAt)}` }) : null;
    return el('section', { class: 'card app' }, top,
      el('div', { class: 'guilds' }, ...(d.guilds || []).map(guildBlock)),
      el('details', {}, el('summary', { text: 'Answers' }), answers),
      el('div', { class: 'review-row' }, status, note),
      el('div', { class: 'actions' }, save, reset, msg, reviewed),
      confirm);
  }

  function render() {
    renderSummary();
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
    if (!data.persistent) flash('Applications are not on a volume yet, so a redeploy erases them. Attach a volume to the monitor service on Railway.');
    $('summary').hidden = false;
    render();
  }

  $('search').addEventListener('input', render);
  $('sort').addEventListener('change', render);
  load();
})();
