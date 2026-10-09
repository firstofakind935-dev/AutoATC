// Draws the FMS / autopilot cockpit from a plain "view model" and turns
// every click or keypress into a plain message - no flight logic here.
//
// Shared by the FMS window (renderer/fms.html, where fms.js builds the view
// model and handles the messages) and the remote-control page served to a
// phone or tablet (remote/index.html, which gets the view model from the
// companion app and posts the messages back). Same drawing code on both, so
// they always look and behave the same.
//
// Messages: {type:'lsk', id:'L1'..'R6'} {type:'fkey', index}
//           {type:'key', ch} {type:'panel', id, action, big}
// where panel action is click | inc | dec | push | pull.

(function (root) {
  const $ = (id) => document.getElementById(id);
  const NUMERIC = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '+/-'];

  function escapeHtml(text) {
    return String(text).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  }
  const cells = (list) => list.map(([text, cls]) => `<span class="${escapeHtml(cls)}">${escapeHtml(text)}</span>`).join('');

  let dispatch = () => {};
  let lastFkeys = '';
  let lastAlpha = '';
  let lastAnnun = '';

  /** Builds the fixed parts (line select keys, keypad) and wires input. */
  function mount(onMessage) {
    dispatch = onMessage;
    for (const [side, el] of [['L', $('lsk-left')], ['R', $('lsk-right')]]) {
      for (let i = 1; i <= 6; i++) {
        const b = document.createElement('button');
        b.className = 'lsk';
        b.setAttribute('aria-label', `Line select ${i}${side}`);
        b.addEventListener('click', () => dispatch({ type: 'lsk', id: `${side}${i}` }));
        el.append(b);
      }
    }
    for (const ch of NUMERIC) {
      const b = document.createElement('button');
      b.className = 'key num';
      b.textContent = ch;
      b.addEventListener('click', () => dispatch({ type: 'key', ch }));
      $('numeric').append(b);
    }
    // Function keys, letters (each style has its own set) and the autopilot
    // panel are redrawn when they change, so they're wired once here by
    // delegation rather than per button.
    for (const id of ['fkeys', 'navkeys']) {
      $(id).addEventListener('click', (e) => {
        const b = e.target.closest('button[data-index]');
        if (b) dispatch({ type: 'fkey', index: Number(b.dataset.index) });
      });
    }
    $('alpha').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-ch]');
      if (b) dispatch({ type: 'key', ch: b.dataset.ch });
    });
    $('ap-panel').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-id]');
      if (b) dispatch({ type: 'panel', id: b.dataset.id, action: b.dataset.action, big: e.shiftKey });
    });
    $('ap-panel').addEventListener('wheel', (e) => {
      const w = e.target.closest('.knob-window[data-id]');
      if (!w) return;
      e.preventDefault();
      dispatch({ type: 'panel', id: w.dataset.id, action: e.deltaY < 0 ? 'inc' : 'dec', big: e.shiftKey });
    }, { passive: false });
    // A physical keyboard types into the scratchpad too.
    document.addEventListener('keydown', (e) => {
      if (e.target.closest('input, select, textarea, dialog')) return;
      let ch = null;
      if (/^[a-z0-9]$/i.test(e.key)) ch = e.key.toUpperCase();
      else if (e.key === 'Backspace') ch = 'CLR';
      else if (e.key === 'Delete') ch = 'DEL';
      else if (e.key === ' ') ch = 'SP';
      else if (e.key === '/' || e.key === '.') ch = e.key;
      if (!ch) return;
      e.preventDefault();
      dispatch({ type: 'key', ch });
    });
  }

  function renderScreen(screen) {
    let html = `<div class="line title"><span class="center">${escapeHtml(screen.title)}</span><span class="right small">${escapeHtml(screen.titleRight || '')}</span></div>`;
    for (const r of screen.rows) {
      html += `<div class="line label-line"><span>${cells(r.label[0])}</span><span>${cells(r.label[1])}</span></div>`;
      html += `<div class="line"><span>${cells(r.data[0])}</span><span>${cells(r.data[1])}</span></div>`;
    }
    const sp = screen.scratch.text ? `<span class="${escapeHtml(screen.scratch.cls || '')}">${escapeHtml(screen.scratch.text)}</span>` : '&nbsp;';
    html += `<div class="line scratch">${sp}</div>`;
    $('screen').innerHTML = html;
  }

  function keyHtml(k, i) {
    if (k.kind === 'spacer') return '<span class="fkey spacer"></span>';
    if (k.kind === 'knob') return '<span class="fkey knob-deco" aria-hidden="true"></span>';
    const label = escapeHtml(k.label).replace(' ', '<br>');
    return `<button class="fkey ${k.exec ? 'exec' : ''} ${k.kind === 'blank' ? 'blank-key' : ''} ${escapeHtml(k.cls || '')}" data-index="${i}">${label}</button>`;
  }

  function renderKeys(vm) {
    const key = JSON.stringify([vm.fkeys, vm.fkeyCols]);
    if (key !== lastFkeys) {
      lastFkeys = key;
      const main = [];
      const nav = [];
      vm.fkeys.forEach((k, i) => (k.group === 'nav' ? nav : main).push(keyHtml(k, i)));
      $('fkeys').innerHTML = main.join('');
      $('fkeys').style.gridTemplateColumns = `repeat(${vm.fkeyCols}, 1fr)`;
      $('navkeys').innerHTML = nav.join('');
      $('navkeys').hidden = nav.length === 0;
    }
    for (const exec of document.querySelectorAll('.fkey.exec')) exec.classList.toggle('lit', Boolean(vm.execLit));

    const alpha = JSON.stringify(vm.alpha);
    if (alpha !== lastAlpha) {
      lastAlpha = alpha;
      $('alpha').innerHTML = vm.alpha.map((ch) => `<button class="key ${ch.length > 1 ? 'small' : ''}" data-ch="${escapeHtml(ch)}">${ch === 'OVFY' ? 'OVFY<br>△' : escapeHtml(ch)}</button>`).join('');
    }

    const annun = JSON.stringify(vm.annunciators);
    if (annun !== lastAnnun) {
      lastAnnun = annun;
      $('annun').innerHTML = vm.annunciators.map(([text, state]) => `<span class="annun-light ${state}">${escapeHtml(text)}</span>`).join('');
      $('annun').hidden = vm.annunciators.length === 0;
    }
  }

  function panelItemHtml(item, skin) {
    if (item.type === 'group') return `<div class="group">${item.items.map((i) => panelItemHtml(i, skin)).join('')}</div>`;
    if (item.type === 'button') {
      return `<button class="ap-btn ${item.lit ? 'lit' : ''} ${escapeHtml(item.cls || '')}" data-id="${item.id}" data-action="click">${escapeHtml(item.label)}</button>`;
    }
    const value = item.managed && skin === 'airbus' ? '---•' : item.value;
    const btn = (action, text, title) => `<button data-id="${item.id}" data-action="${action}" title="${escapeHtml(title)}">${escapeHtml(text)}</button>`;
    return `<div class="knob"><div class="knob-label">${escapeHtml(item.label)}</div>`
      + `<div class="knob-window ${item.managed ? 'managed' : ''}" data-id="${item.id}">${escapeHtml(value)}</div>`
      + `<div class="knob-controls">${btn('dec', '−', `-${item.step} (Shift: -${item.bigStep})`)}${btn('inc', '+', `+${item.step} (Shift: +${item.bigStep})`)}`
      + `${item.pushLabel ? btn('push', item.pushLabel, 'Push (managed)') : ''}${item.pullLabel ? btn('pull', item.pullLabel, 'Pull (selected)') : ''}</div></div>`;
  }

  function renderStatus(status) {
    const trk = $('trk-status');
    if (trk) {
      trk.textContent = status.trackText;
      trk.className = `pill ${status.trackGood ? 'good' : 'bad'}`;
    }
    if ($('readout')) {
      $('readout').innerHTML = status.readout.map(([k, v, extra]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}${extra ? ` <span class="dim">${escapeHtml(extra)}</span>` : ''}</dd>`).join('');
    }
    if ($('input-mode')) $('input-mode').textContent = status.live ? '(LIVE — sent to game)' : '(DRY RUN — not sent)';
    if ($('ap-log')) $('ap-log').innerHTML = status.log.map((l) => `<li>${escapeHtml(l)}</li>`).join('') || '<li class="dim">None yet</li>';
    const live = $('live-toggle');
    if (live) {
      live.textContent = status.live ? 'LIVE' : 'DRY RUN';
      live.className = `pill-btn ${status.live ? 'live' : 'dry'}`;
    }
  }

  /** Draws everything from a view model built by fms.js's buildView(). */
  function render(vm) {
    document.body.dataset.skin = vm.skin;
    renderScreen(vm.screen);
    renderKeys(vm);
    $('ap-panel').innerHTML = vm.panel.map((i) => panelItemHtml(i, vm.skin)).join('');
    $('fma').innerHTML = vm.fma.cols.map((text, i) => `<div class="fma-col ${i === 3 ? 'ap' : ''}">${escapeHtml(text || '')}</div>`).join('')
      + (vm.fma.warn ? `<div class="fma-warn">${escapeHtml(vm.fma.warn)}</div>` : '');
    renderStatus(vm.status);
  }

  root.FmsView = { mount, render, renderStatus };
})(typeof self !== 'undefined' ? self : this);
