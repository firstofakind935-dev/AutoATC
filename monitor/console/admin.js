// The admin radio console: listen to any or all frequencies, and talk (or type) on any of them without taking it
// over - the hub lets an admin key do that (monitor/radio.js). Same radio client as the pilots' app (radio.js).
(function () {
  const $ = (id) => document.getElementById(id);
  const R = window.AppRadio;
  const listening = new Set();
  let talk = null; // the frequency push-to-talk and typed messages go out on
  let connected = false;
  let admin = false;
  const busy = new Map(); // freq -> who is transmitting

  const saved = (() => { try { return JSON.parse(localStorage.getItem('console') || '{}'); } catch { return {}; } })();
  const savedAdmin = (() => { try { return JSON.parse(localStorage.getItem('admin-console') || '{}'); } catch { return {}; } })();
  $('callsign').value = saved.callsign || '';
  $('key').value = savedAdmin.key || saved.key || '';
  $('volume').value = saved.volume != null ? saved.volume : 1;
  R.setVolume($('volume').value);
  for (const f of savedAdmin.listening || []) listening.add(f);
  talk = savedAdmin.talk || null;
  const save = () => {
    try {
      localStorage.setItem('console', JSON.stringify({ ...saved, callsign: $('callsign').value, volume: Number($('volume').value) }));
      localStorage.setItem('admin-console', JSON.stringify({ key: $('key').value, listening: [...listening], talk }));
    } catch { /* private mode */ }
  };

  function log(text, cls = '', freq = null) {
    const line = document.createElement('div');
    if (cls) line.className = cls;
    const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    line.textContent = `${t}  ${freq ? `${freq}  ` : ''}${text}`;
    const el = $('log');
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
    el.appendChild(line);
    while (el.childNodes.length > 500) el.removeChild(el.firstChild);
    if (atBottom) el.scrollTop = el.scrollHeight;
  }

  function retune() {
    R.tune(talk, [...listening, ...(talk ? [talk] : [])]);
    const st = talk && R.stationOn(talk);
    $('talkOn').textContent = talk ? `Talking on ${talk}${st ? ` (${st.callsign})` : ''}` : 'Pick a frequency with Talk.';
    $('ptt').disabled = !(connected && admin && talk);
    $('sayBtn').disabled = !(connected && admin && talk);
    save();
    render();
  }

  function render() {
    const q = $('filter').value.trim().toLowerCase();
    const body = $('stations');
    body.textContent = '';
    for (const s of R.stations) {
      if (q && ![s.freq, s.station || '', s.callsign || ''].some((v) => v.toLowerCase().includes(q))) continue;
      const tr = document.createElement('tr');
      if (s.freq === talk) tr.className = 'talk';
      if (busy.has(s.freq)) tr.classList.add('busy');
      const cell = (text, cls) => { const td = document.createElement('td'); td.textContent = text; if (cls) td.className = cls; return td; };
      const tag = document.createElement('span');
      tag.className = `tag ${s.staffed === 'human' ? 'human' : 'ai'}`;
      tag.textContent = s.staffed === 'human' ? `Live: ${s.controller}` : 'AI';
      const tagCell = cell('');
      tagCell.append(tag);
      const lc = cell('');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = listening.has(s.freq);
      cb.setAttribute('aria-label', `Listen to ${s.freq}`);
      cb.addEventListener('change', () => { if (cb.checked) listening.add(s.freq); else listening.delete(s.freq); retune(); });
      lc.append(cb);
      const tc = cell('');
      const rb = document.createElement('input');
      rb.type = 'radio';
      rb.name = 'talk';
      rb.checked = s.freq === talk;
      rb.setAttribute('aria-label', `Talk on ${s.freq}`);
      rb.addEventListener('change', () => { talk = s.freq; retune(); });
      tc.append(rb);
      tr.append(cell(s.freq, 'f'), cell(`${s.callsign || ''}${busy.has(s.freq) ? ` - ${busy.get(s.freq)} transmitting` : ''}`), tagCell, lc, tc);
      body.append(tr);
    }
  }

  R.on('status', (state, detail) => {
    connected = state === 'connected';
    if (!connected) admin = false;
    $('status').textContent = { connected: admin ? 'Connected (admin)' : 'Connected', connecting: 'Connecting...', reconnecting: 'Reconnecting... (wrong admin key?)', off: detail || 'Not connected' }[state] || state;
    $('status').className = `pill ${connected ? 'ok' : state === 'off' ? '' : 'bad'}`;
    $('bcSend').disabled = !connected;
    retune();
  });
  R.on('stations', render);
  R.on('ptt', (state, info) => {
    $('ptt').classList.toggle('tx', state === 'transmitting');
    if (state === 'denied') log(`Can't transmit: ${info}`, 'warn');
  });
  R.on('log', (e) => {
    if (e.kind === 'warn') return log(e.text, 'warn');
    if (e.kind === 'broadcast') return log(`ALL AIRCRAFT (${e.from}): ${e.text}`, 'bc');
    if (e.kind === 'rx' && e.live) { busy.set(e.freq, e.from); render(); setTimeout(() => { busy.delete(e.freq); render(); }, 8000); return; }
    if (e.live) return;
    busy.delete(e.freq);
    log(`${e.from || '?'}: ${e.text}`, e.kind === 'atc' ? 'atc' : e.from === $('callsign').value.trim() ? 'me' : '', e.freq);
  });
  R.on('broadcast-sent', (text, n) => { $('bcNote').textContent = `Sent to ${n} pilot${n === 1 ? '' : 's'}.`; });
  R.on('admin', () => { admin = true; $('status').textContent = 'Connected (admin)'; retune(); });

  $('connect').addEventListener('click', () => {
    const callsign = $('callsign').value.trim();
    if (!callsign) { $('callsign').focus(); return; }
    save();
    R.connect(location.origin, callsign, { role: 'controller', key: $('key').value, admin: true });
  });
  $('filter').addEventListener('input', render);
  $('volume').addEventListener('change', () => { R.setVolume($('volume').value); save(); });
  $('listenAll').addEventListener('click', () => { for (const s of R.stations) listening.add(s.freq); retune(); });
  $('listenNone').addEventListener('click', () => { listening.clear(); retune(); });
  $('sayForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = $('sayText').value.trim();
    if (text && R.say(text)) $('sayText').value = '';
  });
  $('bcForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = $('bcText').value.trim();
    if (!text) return;
    R.broadcast(text);
    $('bcText').value = '';
  });

  const ptt = $('ptt');
  ptt.addEventListener('pointerdown', () => R.setPtt(true));
  for (const ev of ['pointerup', 'pointerleave']) ptt.addEventListener(ev, () => R.setPtt(false));
  const typing = (e) => /^(INPUT|TEXTAREA)$/.test(e.target.tagName) && e.target.type !== 'checkbox' && e.target.type !== 'radio';
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || typing(e)) return;
    e.preventDefault();
    if (!e.repeat && talk && admin) R.setPtt(true);
  });
  window.addEventListener('keyup', (e) => { if (e.code === 'Space' && !typing(e)) { e.preventDefault(); R.setPtt(false); } });
  window.addEventListener('blur', () => R.setPtt(false));

  // ---- flight plans: close any of them (POST /api/flightplans/<callsign>/close with the admin key) ----
  let filingOpen = true;
  function showFiling() {
    $('filingState').textContent = filingOpen ? 'Filing: open' : 'Filing: closed';
    $('filingState').className = `pill ${filingOpen ? 'ok' : 'bad'}`;
    $('filingToggle').textContent = filingOpen ? 'Close filing' : 'Open filing';
  }
  $('filingToggle').addEventListener('click', async () => {
    const r = await fetch('/api/flightplans/filing', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-key': $('key').value }, body: JSON.stringify({ open: !filingOpen }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { $('planNote').textContent = d.error || 'Could not change it.'; return; }
    filingOpen = d.filingOpen;
    showFiling();
    $('planNote').textContent = filingOpen ? 'Pilots can file flight plans again.' : 'New flight plans are refused. Filed plans stay.';
  });

  async function loadPlans() {
    let plans = [];
    try {
      const d = await (await fetch('/api/flightplans', { cache: 'no-store' })).json();
      plans = d.plans || [];
      if (typeof d.filingOpen === 'boolean') { filingOpen = d.filingOpen; showFiling(); }
    } catch { return; }
    const body = $('plans');
    body.textContent = '';
    const cell = (text, cls) => { const td = document.createElement('td'); td.textContent = text; if (cls) td.className = cls; return td; };
    if (!plans.length) { const tr = document.createElement('tr'); const td = cell('No open flight plans.', 'hint'); td.colSpan = 6; tr.append(td); body.append(tr); }
    for (const p of plans) {
      const tr = document.createElement('tr');
      const act = cell('');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Close';
      btn.addEventListener('click', async () => {
        if (btn.dataset.armed !== '1') { btn.dataset.armed = '1'; btn.textContent = 'Confirm close'; setTimeout(() => { btn.dataset.armed = ''; btn.textContent = 'Close'; }, 4000); return; }
        btn.disabled = true;
        const r = await fetch(`/api/flightplans/${encodeURIComponent(p.callsign)}/close`, { method: 'POST', headers: { 'x-admin-key': $('key').value } });
        const d = r.ok ? {} : await r.json().catch(() => ({}));
        $('planNote').textContent = r.ok ? `${p.callsign} closed.` : (d.error || 'Could not close it.');
        loadPlans();
      });
      act.append(btn);
      tr.append(cell(p.callsign, 'f'), cell(p.aircraft), cell(`${p.dep} → ${p.arr}`), cell(p.squawk, 'f'), cell(p.filedBy || ''), act);
      body.append(tr);
    }
  }
  loadPlans();
  setInterval(loadPlans, 15000);

  if ($('callsign').value && $('key').value) $('connect').click();
})();
