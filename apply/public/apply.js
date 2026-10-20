// The applicant's page: sign in with Discord, see what we read, answer the questions once.
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
  const DRAFT_KEY = 'apply-draft';
  const ago = (iso) => {
    const d = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
    if (!Number.isFinite(d)) return '';
    if (d < 1) return 'today';
    if (d < 60) return `${d} day${d === 1 ? '' : 's'} ago`;
    const m = Math.floor(d / 30.44);
    if (m < 24) return `${m} months ago`;
    return `${(d / 365.25).toFixed(1)} years ago`;
  };
  const date = (iso) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const hex = (c) => (c ? `#${c.toString(16).padStart(6, '0')}` : null);

  function flash(text) { $('flash').textContent = text; $('flash').hidden = !text; }

  const params = new URLSearchParams(location.search);
  if (params.get('signin') === 'failed') flash('Discord sign-in failed. Try again.');
  if (params.get('signin') === 'cancelled') flash('Sign-in was cancelled.');
  if (params.has('signin')) history.replaceState(null, '', '/apply/');

  function renderGuilds(profile) {
    const box = $('guilds');
    box.replaceChildren();
    for (const g of profile.guilds) {
      const head = el('div', { class: 'head' },
        el('span', { class: 'gname', text: g.name }),
        el('span', { class: 'mono', text: g.member ? `Joined ${date(g.joinedAt)} · ${ago(g.joinedAt)}` : (g.required ? 'Not a member · required to apply' : 'Not a member') }));
      const roles = el('div', { class: 'roles' });
      if (g.member) {
        if (!g.roles.length) roles.append(el('span', { class: 'hint', text: 'No roles' }));
        for (const r of g.roles) {
          const dot = el('i');
          if (hex(r.color)) dot.style.background = hex(r.color);
          roles.append(el('span', { class: 'role' }, dot, document.createTextNode(r.name || `Role ${r.id}`)));
        }
      }
      box.append(el('div', { class: `guild${g.member ? '' : ' out'}` }, head, g.member ? roles : null));
    }
    if (!profile.guilds.length) box.append(el('p', { class: 'hint', text: 'No servers are set up for role checks yet.' }));
  }

  function loadDraft() { try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}') || {}; } catch { return {}; } }
  function saveDraft(d) { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch { /* private mode */ } }

  function renderForm(questions) {
    const form = $('form');
    form.replaceChildren();
    const draft = loadDraft();
    for (const q of questions) {
      const id = `q_${q.id}`;
      const req = q.required ? el('span', { class: 'req', text: '*', 'aria-hidden': 'true' }) : null;
      let field;
      if (q.type === 'rank') {
        field = el('fieldset', { class: 'q' }, el('legend', {}, document.createTextNode(q.label), req));
        if (q.hint) field.append(el('p', { class: 'hint', text: q.hint }));
        const rank = el('div', { class: 'rank' });
        const saved = Array.isArray(draft[q.id]) ? draft[q.id] : [];
        for (let i = 0; i < q.picks; i++) {
          const sel = el('select', { id: `${id}_${i}`, 'data-rank': q.id, 'aria-label': `${q.label}: choice ${i + 1}` }, el('option', { value: '', text: 'Choose…' }));
          for (const o of q.options) sel.append(el('option', { value: o, text: o, selected: saved[i] === o }));
          rank.append(el('div', { class: 'row' }, el('span', { text: ['1st', '2nd', '3rd'][i] || `${i + 1}th` }), sel));
        }
        field.append(rank);
      } else {
        field = el('div', { class: 'q' }, el('label', { for: id }, document.createTextNode(q.label), req));
        if (q.hint) field.append(el('p', { class: 'hint', text: q.hint }));
        let input;
        if (q.type === 'select') {
          input = el('select', { id, name: q.id }, el('option', { value: '', text: 'Choose…' }));
          for (const o of q.options) input.append(el('option', { value: o, text: o, selected: draft[q.id] === o }));
        } else if (q.type === 'textarea') {
          input = el('textarea', { id, name: q.id, maxlength: q.max || 1500 });
          input.value = draft[q.id] || '';
        } else {
          input = el('input', { id, name: q.id, type: 'text', maxlength: q.max || 200, autocomplete: 'off' });
          input.value = draft[q.id] || '';
        }
        field.append(input);
      }
      form.append(field);
    }
    form.append(el('div', { class: 'actions' },
      el('button', { type: 'submit', class: 'primary', id: 'submit', text: 'Send application' }),
      el('span', { class: 'note', id: 'formNote', role: 'status' })));

    const collect = () => {
      const answers = {};
      for (const q of questions) {
        if (q.type === 'rank') answers[q.id] = [...form.querySelectorAll(`select[data-rank="${q.id}"]`)].map((s) => s.value).filter(Boolean);
        else answers[q.id] = form.elements[q.id].value;
      }
      return answers;
    };
    form.addEventListener('input', () => saveDraft(collect()));
    form.addEventListener('change', () => saveDraft(collect()));
    let confirming = false;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const note = $('formNote');
      const answers = collect();
      for (const q of questions) {
        const v = answers[q.id];
        const empty = q.type === 'rank' ? v.length < q.picks : !String(v).trim();
        if (q.required && empty) { note.className = 'note bad'; note.textContent = `Answer "${q.label}" first.`; return; }
        if (q.type === 'rank' && new Set(v).size !== v.length) { note.className = 'note bad'; note.textContent = 'Pick a different position for each choice.'; return; }
      }
      if (!confirming) {
        confirming = true;
        $('submit').textContent = 'Yes, send it (you can only apply once)';
        note.className = 'note warn';
        note.textContent = 'Check your answers, then press again to send.';
        return;
      }
      $('submit').disabled = true;
      note.className = 'note'; note.textContent = 'Sending…';
      try {
        const r = await fetch('/apply/api/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answers }) });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || 'Something went wrong. Try again.');
        try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
        load();
      } catch (err) {
        note.className = 'note bad'; note.textContent = err.message;
        $('submit').disabled = false;
        confirming = false;
        $('submit').textContent = 'Send application';
      }
    });
  }

  async function load() {
    let me;
    try { me = await (await fetch('/apply/api/me', { cache: 'no-store' })).json(); } catch { flash('Could not reach the server. Reload the page.'); return; }
    $('signedOut').hidden = me.signedIn;
    $('who').hidden = !me.signedIn;
    $('formCard').hidden = true; $('blocked').hidden = true; $('done').hidden = true;
    if (!me.configured) { $('signedOut').hidden = true; flash('Applications open soon: Discord sign-in is not set up yet.'); return; }
    if (!me.signedIn) return;
    if (me.needsRefresh || !me.profile) { $('who').hidden = true; $('signedOut').hidden = false; flash('Sign in again so we can read your current roles.'); return; }

    const p = me.profile;
    const pic = p.avatar ? el('img', { id: 'avatar', src: p.avatar, alt: '' }) : el('div', { id: 'avatar', class: 'avatar' });
    $('avatar').replaceWith(pic);
    $('displayName').textContent = p.displayName;
    $('accountSub').textContent = `@${p.username} · account created ${date(p.createdAt)} (${ago(p.createdAt)})`;
    $('reviewLink').hidden = !me.admin;
    renderGuilds(p);

    if (me.application) {
      $('done').hidden = false;
      const o = me.outcome;
      $('done').textContent = !o ? `Application received on ${date(me.application.submittedAt)}. The event team will contact you on Discord.`
        : o.result === 'position' ? `You're controlling ${o.position} at the event. The event team will brief you on Discord.`
        : o.result === 'waitlist' ? "The roster is out and you're on the waitlist. We'll message you on Discord if a position opens up."
        : "The roster is out and you don't have a position this time. Thanks for applying.";
      return;
    }
    if (!me.open) { $('blocked').hidden = false; $('blocked').textContent = 'Applications are closed.'; return; }
    if (me.missing.length) { $('blocked').hidden = false; $('blocked').textContent = `Join ${me.missing.join(' and ')} first, then sign in again.`; return; }
    $('formCard').hidden = false;
    renderForm(me.questions);
  }

  $('logout').addEventListener('click', async () => { await fetch('/apply/logout', { method: 'POST' }); load(); });
  load();
})();
