// The human controllers' console for the in-app radio (monitor/radio.js): listen to any frequency, take one over from
// the AI (it goes quiet there at once, and you get the frequency's recent transcript), talk with push-to-talk, hand
// it back. Uses the same radio client as the pilots' app (radio.js, kept identical to companion/renderer/radio.js).

(function () {
  const $ = (id) => document.getElementById(id);
  const R = window.AppRadio;
  const held = new Set(); // frequencies this console has taken over
  const listening = new Set(); // extra frequencies just being listened to
  let tx = null; // which held frequency push-to-talk transmits on
  let connected = false;

  const saved = (() => { try { return JSON.parse(localStorage.getItem('console') || '{}'); } catch { return {}; } })();
  $('callsign').value = saved.callsign || '';
  $('key').value = saved.key || '';
  $('volume').value = saved.volume != null ? saved.volume : 1;
  R.setVolume($('volume').value);
  const save = () => { try { localStorage.setItem('console', JSON.stringify({ callsign: $('callsign').value, key: $('key').value, volume: Number($('volume').value) })); } catch {} };

  // ---- log ----
  function log(text, cls = '', freq = null) {
    const line = document.createElement('div');
    if (cls) line.className = cls;
    const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    line.textContent = `${t}  ${freq ? `${freq}  ` : ''}${text}`;
    const el = $('log');
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
    el.appendChild(line);
    while (el.childNodes.length > 400) el.removeChild(el.firstChild);
    if (atBottom) el.scrollTop = el.scrollHeight;
  }

  // ---- tuning ----
  function retune() {
    if (tx && !held.has(tx)) tx = null;
    if (!tx && held.size) tx = [...held][0];
    R.tune(tx, [...held, ...listening]);
    renderHeld();
    renderStations();
  }

  function renderHeld() {
    const box = $('held');
    box.textContent = '';
    if (!held.size) {
      const s = document.createElement('span');
      s.className = 'hint';
      s.textContent = 'Take a station over to transmit on it.';
      box.appendChild(s);
    }
    for (const f of held) {
      const st = R.stationOn(f);
      const label = document.createElement('label');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'tx';
      radio.checked = f === tx;
      radio.addEventListener('change', () => { tx = f; retune(); });
      const b = document.createElement('button');
      b.className = 'back';
      b.textContent = 'Hand back';
      b.addEventListener('click', () => R.handback(f));
      label.append(radio, ` TX ${f} ${st && st.station ? `- ${st.station}` : ''} `, b);
      box.appendChild(label);
    }
    $('ptt').disabled = !connected || !tx;
    $('ptt').textContent = tx ? `Hold to talk on ${tx} (or hold Space)` : 'Hold to talk (take a station over first)';
  }

  function renderStations() {
    const filter = $('filter').value.trim().toLowerCase();
    const body = $('stations');
    body.textContent = '';
    for (const s of R.stations) {
      const text = `${s.freq} ${s.station || ''} ${s.callsign || ''}`.toLowerCase();
      if (filter && !text.includes(filter)) continue;
      const tr = document.createElement('tr');
      const mine = held.has(s.freq);
      const f = document.createElement('td'); f.className = 'f'; f.textContent = s.freq;
      const who = document.createElement('td'); who.className = 'who';
      who.textContent = `${s.station || ''}${s.callsign ? ` - ${s.callsign}` : ''}${s.controller && !mine ? ` (${s.controller})` : ''}`;
      const state = document.createElement('td');
      const tag = document.createElement('span');
      tag.className = `tag ${mine ? 'mine' : s.staffed === 'human' ? 'human' : 'ai'}`;
      tag.textContent = mine ? 'you' : s.staffed === 'human' ? 'human' : 'AI';
      state.appendChild(tag);
      const actions = document.createElement('td');
      const wrap = document.createElement('div'); wrap.className = 'row-actions';
      const listen = document.createElement('label'); listen.className = 'listen';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = mine || listening.has(s.freq); cb.disabled = mine;
      cb.addEventListener('change', () => { if (cb.checked) listening.add(s.freq); else listening.delete(s.freq); retune(); });
      listen.append(cb, 'Listen');
      const btn = document.createElement('button');
      if (mine) { btn.className = 'back'; btn.textContent = 'Hand back'; btn.onclick = () => R.handback(s.freq); }
      else { btn.className = 'take'; btn.textContent = 'Take over'; btn.disabled = !connected || s.staffed === 'human'; btn.onclick = () => R.takeover(s.freq); }
      wrap.append(listen, btn);
      actions.appendChild(wrap);
      tr.append(f, who, state, actions);
      body.appendChild(tr);
    }
  }

  // ---- radio events ----
  R.on('status', (state, detail) => {
    connected = state === 'connected';
    const el = $('status');
    el.textContent = { connected: 'Connected', connecting: 'Connecting...', reconnecting: 'Reconnecting...', off: detail || 'Not connected' }[state] || state;
    el.className = `pill ${connected ? 'ok' : state === 'off' ? '' : 'bad'}`;
    if (connected) for (const f of held) R.takeover(f); // after a dropped connection, take them back
    renderHeld();
    renderStations();
  });
  R.on('stations', () => { renderStations(); renderHeld(); });
  R.on('control', (type, freq, ok, reason) => {
    if (type === 'takeover') {
      if (!ok) { log(`Can't take ${freq}: ${reason}`, 'l-warn'); return; }
      const first = !held.has(freq);
      held.add(freq);
      tx = freq;
      if (first) log('You have this frequency - the AI is quiet here.', 'l-ctl', freq);
    } else if (type === 'handback') {
      if (held.delete(freq)) log('Handed back to the AI.', 'l-ctl', freq);
    }
    retune();
  });
  R.on('history', (freq, lines) => {
    if (!lines.length) { log('(nothing said here in the last 20 minutes)', 'l-hist', freq); return; }
    log(`--- last ${lines.length} transmissions ---`, 'l-hist', freq);
    for (const l of lines) {
      const t = new Date(l.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      log(`[${t}] ${l.from || '?'}: ${l.text}`, 'l-hist', freq);
    }
    log('--- now ---', 'l-hist', freq);
  });
  R.on('ptt', (state, info) => {
    $('ptt').classList.toggle('tx', state === 'transmitting');
    if (state === 'denied') log(`Can't transmit: ${info}`, 'l-warn');
  });
  R.on('log', (e) => {
    if (e.kind === 'warn') return log(e.text, 'l-warn');
    if (e.live) return;
    log(`${e.from || '?'}: ${e.text}`, e.kind === 'atc' ? 'l-atc' : e.from === $('callsign').value.trim() ? 'l-ctl' : '', e.freq);
  });

  // ---- controls ----
  $('connect').addEventListener('click', () => {
    const callsign = $('callsign').value.trim();
    if (!callsign) { $('callsign').focus(); return; }
    save();
    R.connect(location.origin, callsign, { role: 'controller', key: $('key').value });
  });
  $('filter').addEventListener('input', renderStations);
  $('volume').addEventListener('change', () => { R.setVolume($('volume').value); save(); });

  const ptt = $('ptt');
  ptt.addEventListener('pointerdown', () => R.setPtt(true));
  for (const ev of ['pointerup', 'pointerleave']) ptt.addEventListener(ev, () => R.setPtt(false));
  const typing = (e) => /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && e.target.type !== 'checkbox' && e.target.type !== 'radio';
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || typing(e)) return;
    e.preventDefault();
    if (!e.repeat && tx) R.setPtt(true);
  });
  window.addEventListener('keyup', (e) => { if (e.code === 'Space' && !typing(e)) { e.preventDefault(); R.setPtt(false); } });
  window.addEventListener('blur', () => R.setPtt(false));

  renderHeld();
  if (saved.callsign) $('connect').click();
})();
