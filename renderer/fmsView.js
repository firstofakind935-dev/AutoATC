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
//           {type:'clear-info'} (the A350 MFD's CLEAR INFO button)
// where panel action is click | inc | dec | push | pull.

(function (root) {
  const $ = (id) => document.getElementById(id);

  function escapeHtml(text) {
    return String(text).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  }
  const cells = (list) => list.map(([text, cls]) => `<span class="${escapeHtml(cls)}">${escapeHtml(text)}</span>`).join('');

  let dispatch = () => {};
  let lastFkeys = '';
  let lastAlpha = '';
  let lastNumeric = '';
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
    // Function keys, letters (each style has its own set) and the autopilot
    // panel are redrawn when they change, so they're wired once here by
    // delegation rather than per button.
    for (const id of ['fkeys', 'navkeys']) {
      $(id).addEventListener('click', (e) => {
        const b = e.target.closest('button[data-index]');
        if (b) dispatch({ type: 'fkey', index: Number(b.dataset.index) });
      });
    }
    $('screen').addEventListener('click', (e) => {
      const field = e.target.closest('[data-lsk]');
      if (field) return dispatch({ type: 'lsk', id: field.dataset.lsk });
      const tab = e.target.closest('[data-index]');
      if (tab) return dispatch({ type: 'fkey', index: Number(tab.dataset.index) });
      if (e.target.closest('.mfd-clear')) return dispatch({ type: 'clear-info' });
      return null;
    });
    for (const id of ['alpha', 'numeric']) {
      $(id).addEventListener('click', (e) => {
        const b = e.target.closest('button[data-ch]');
        if (b) dispatch({ type: 'key', ch: b.dataset.ch });
      });
    }
    $('ap-panel').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-id]');
      if (b) dispatch({ type: 'panel', id: b.dataset.id, action: b.dataset.action, big: e.shiftKey });
    });
    $('ap-panel').addEventListener('wheel', (e) => {
      const w = e.target.closest('.knob-window[data-id], [data-wheel]');
      if (!w) return;
      e.preventDefault();
      dispatch({ type: 'panel', id: w.dataset.id || w.dataset.wheel, action: e.deltaY < 0 ? 'inc' : 'dec', big: e.shiftKey });
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

  function renderScreen(screen, tabs, keys) {
    if (screen.style === 'mfd') return renderMfdScreen(screen, tabs);
    if (screen.style === 'fusion') return renderFusionScreen(screen, keys);
    let html = `<div class="line title"><span class="center">${escapeHtml(screen.title)}</span><span class="right small">${escapeHtml(screen.titleRight || '')}</span></div>`;
    for (const r of screen.rows) {
      html += `<div class="line label-line"><span>${cells(r.label[0])}</span><span>${cells(r.label[1])}</span></div>`;
      html += `<div class="line"><span>${cells(r.data[0])}</span><span>${cells(r.data[1])}</span></div>`;
    }
    const sp = screen.scratch.text ? `<span class="${escapeHtml(screen.scratch.cls || '')}">${escapeHtml(screen.scratch.text)}</span>` : '&nbsp;';
    html += `<div class="line scratch">${sp}</div>`;
    $('screen').innerHTML = html;
    return null;
  }

  // A350/A380 MFD page: tabs, title bar, then each line's left and right
  // halves as clickable fields (each acts as that line select key), and a
  // bottom bar with CLEAR INFO, the typed entry and any message.
  const isAction = (list) => /^[<].|[>*•]$/.test(list.map(([t]) => t).join('').trim());
  function mfdField(id, label, data, selected) {
    const text = data.map(([t]) => t).join('').trim();
    if (!text && !label.length) return '<div class="mfd-field empty"></div>';
    const action = isAction(data);
    const cls = `mfd-field ${action ? 'action' : ''} ${selected ? 'selected' : ''} ${id[0] === 'R' ? 'right' : ''}`;
    const body = action
      ? `<span class="mfd-btn">${escapeHtml(text.replace(/^<|[>*]$/g, '').trim())}${/[*>]$/.test(text) ? ' •' : ''}</span>`
      : `<span class="mfd-label">${cells(label)}</span><span class="mfd-value">${cells(data)}</span>`;
    return `<button class="${cls}" data-lsk="${id}">${body}</button>`;
  }
  function renderMfdScreen(screen, tabs) {
    const tabHtml = tabs.map(({ k, i }) => `<button class="mfd-tab" data-index="${i}">${escapeHtml(k.label)} <span class="caret">▾</span></button>`).join('');
    let html = `<div class="mfd-top"><span class="mfd-fms">FMS 1 <span class="caret">▾</span></span>${tabHtml}</div>`;
    html += `<div class="mfd-title"><span>${escapeHtml(screen.title)}</span><span>${escapeHtml(screen.titleRight || '')}</span></div><div class="mfd-body">`;
    screen.rows.forEach((r, n) => {
      html += `<div class="mfd-row">${mfdField(`L${n + 1}`, r.label[0], r.data[0], screen.selected === `L${n + 1}`)}${mfdField(`R${n + 1}`, r.label[1], r.data[1], screen.selected === `R${n + 1}`)}</div>`;
    });
    const msg = screen.scratch.cls === 'amber' || screen.scratch.cls === 'white';
    html += `</div><div class="mfd-bottom"><button class="mfd-clear" data-key="CLR INFO">CLEAR<br>INFO</button>`
      + `<span class="mfd-entry">${msg ? '' : escapeHtml(screen.scratch.text)}</span>`
      + `<span class="mfd-msg ${msg ? screen.scratch.cls : ''}">${msg ? escapeHtml(screen.scratch.text) : ''}</span></div>`;
    $('screen').innerHTML = html;
    return null;
  }

  // A220 (Pro Line Fusion) page: two tab rows - the active one in blue -
  // then the page's lines as clickable fields, and a bottom bar with
  // THRUST... / MSG..., the typed entry and any message.
  const PHASE_TAB = { CLB: 'CLB', CRZ: 'CRZ', DES: 'DES', APP: 'ARR', DONE: 'ARR' };
  function renderFusionScreen(screen, keys) {
    const tabBtn = ({ k, i }, active, cls) => `<button class="fus-tab ${cls} ${active ? 'active' : ''}" data-index="${i}">${escapeHtml(k.label)}${k.label === 'ACT' ? ' <span class="caret">▾</span>' : ''}${cls === 'btm' ? ' …' : ''}</button>`;
    const tops = keys.filter(({ k }) => k.group === 'tab');
    const perfPage = screen.page === 'perf';
    const subs = keys.filter(({ k }) => k.group === 'subtab' && (k.scope === 'perf') === perfPage);
    const activeSub = perfPage ? (PHASE_TAB[screen.phase] || 'DEP') : null;
    let html = `<div class="fus-tabs top">${tops.map((t) => tabBtn(t, t.k.target === screen.page, 'top')).join('')}</div>`;
    html += `<div class="fus-tabs sub">${subs.map((t) => tabBtn(t, perfPage ? t.k.label === activeSub : t.k.target === screen.page, 'sub')).join('')}</div>`;
    html += `<div class="fus-body"><div class="fus-title"><span>${escapeHtml(screen.title)}</span><span>${escapeHtml(screen.titleRight || '')}</span></div>`;
    screen.rows.forEach((r, n) => {
      html += `<div class="mfd-row">${mfdField(`L${n + 1}`, r.label[0], r.data[0], screen.selected === `L${n + 1}`)}${mfdField(`R${n + 1}`, r.label[1], r.data[1], screen.selected === `R${n + 1}`)}</div>`;
    });
    const msg = screen.scratch.cls === 'amber' || screen.scratch.cls === 'white';
    const bottom = keys.filter(({ k }) => k.group === 'bottom');
    html += `</div><div class="fus-bottom">${bottom[0] ? tabBtn(bottom[0], false, 'btm') : ''}`
      + `<span class="mfd-entry">${msg ? '' : escapeHtml(screen.scratch.text)}</span>`
      + `<span class="mfd-msg ${msg ? screen.scratch.cls : ''}">${msg ? escapeHtml(screen.scratch.text) : ''}</span>`
      + `${bottom[1] ? tabBtn(bottom[1], false, 'btm') : ''}</div>`;
    $('screen').innerHTML = html;
    return null;
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
      vm.fkeys.forEach((k, i) => {
        if (k.group === 'nav') nav.push(keyHtml(k, i));
        else if (k.group === 'main') main.push(keyHtml(k, i));
        // tab / subtab / bottom keys are drawn on the display itself
      });
      $('fkeys').innerHTML = main.join('');
      $('fkeys').style.gridTemplateColumns = `repeat(${vm.fkeyCols}, 1fr)`;
      $('navkeys').innerHTML = nav.join('');
      $('navkeys').hidden = nav.length === 0;
    }
    for (const exec of document.querySelectorAll('.fkey.exec')) exec.classList.toggle('lit', Boolean(vm.execLit));

    // Letter and number keys: each style has its own set and arrangement
    // ('' leaves a gap, as on the real unit).
    const alpha = JSON.stringify([vm.alpha, vm.alphaCols]);
    if (alpha !== lastAlpha) {
      lastAlpha = alpha;
      $('alpha').innerHTML = vm.alpha.map((ch) => (ch
        ? `<button class="key ${ch.length > 1 ? 'small' : ''}" data-ch="${escapeHtml(ch)}">${ch === 'OVFY' ? 'OVFY<br>△' : escapeHtml(ch)}</button>`
        : '<span class="key spacer"></span>')).join('');
      $('alpha').style.gridTemplateColumns = vm.alphaCols ? `repeat(${vm.alphaCols}, 1fr)` : '';
    }
    const numeric = JSON.stringify([vm.numeric, vm.numericCols]);
    if (numeric !== lastNumeric) {
      lastNumeric = numeric;
      $('numeric').innerHTML = vm.numeric.map((ch) => (ch
        ? `<button class="key num" data-ch="${escapeHtml(ch)}">${escapeHtml(ch)}</button>`
        : '<span class="key num spacer"></span>')).join('');
      $('numeric').style.gridTemplateColumns = vm.numericCols !== 3 ? `repeat(${vm.numericCols}, 34px)` : '';
    }

    const annun = JSON.stringify(vm.annunciators);
    if (annun !== lastAnnun) {
      lastAnnun = annun;
      $('annun').innerHTML = vm.annunciators.map(([text, state]) => `<span class="annun-light ${state}">${escapeHtml(text)}</span>`).join('');
      $('annun').hidden = vm.annunciators.length === 0;
    }
  }

  // ---- Boeing MCP and Airbus FCU panels: one control per named slot, laid out like the real units.
  const cpBtn = (c, extra = '') => `<button class="cp-btn ${c.lit ? 'lit' : ''} ${escapeHtml(c.cls || '')} ${extra}" data-id="${c.id}" data-action="click" title="${escapeHtml(c.label)}"><span class="cp-label">${escapeHtml(c.label)}</span><i class="cp-lamp"></i></button>`;
  const cpWin = (label, value, cls = '') => `<div class="cp-win ${cls}"><span class="cp-wlabel">${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`;
  // A round knob: click its left half to turn down, right half to turn up (Shift = big step); the wheel works too.
  const cpKnob = (c, cls = '') => `<div class="cp-knob ${cls}" data-wheel="${c.id}">`
    + `<button data-id="${c.id}" data-action="dec" title="down (Shift: bigger step)">&minus;</button><button data-id="${c.id}" data-action="inc" title="up (Shift: bigger step)">+</button></div>`
    + (c.pushLabel || c.pullLabel
      ? `<div class="cp-pp">${c.pullLabel ? `<button data-id="${c.id}" data-action="pull">${escapeHtml(c.pullLabel)}</button>` : ''}${c.pushLabel ? `<button data-id="${c.id}" data-action="push">${escapeHtml(c.pushLabel)}</button>` : ''}</div>`
      : '');
  const cpWheel = (c) => `<div class="cp-wheel" data-wheel="${c.id}"><span>UP</span><button data-id="${c.id}" data-action="inc" title="climb (Shift: bigger step)"></button><button data-id="${c.id}" data-action="dec" title="descend (Shift: bigger step)"></button><span>DN</span></div>`;

  function mcpHtml(k) {
    return `<div class="cockpit mcp">`
      + `<div class="cp-mod"><div class="cp-stack">${cpWin(k.courseL.label, k.courseL.value)}${cpBtn(k.fdL, 'sw')}</div></div>`
      + `<div class="cp-mod"><div class="cp-label-top">A/T</div>${cpBtn(k.at, 'sw')}</div>`
      + `<div class="cp-mod">${cpWin(k.ias.label, k.ias.value)}<div class="cp-row">${cpKnob(k.ias)}<div class="cp-col">${cpBtn(k.co)}${cpBtn(k.spdIntv)}</div></div><div class="cp-row">${cpBtn(k.n1)}${cpBtn(k.speed)}${cpBtn(k.lvlchg)}</div></div>`
      + `<div class="cp-mod"><div class="cp-grid2">${cpBtn(k.vnav)}${cpBtn(k.lnav)}${cpBtn(k.vorloc)}${cpBtn(k.hdgsel)}${cpBtn(k.app)}</div></div>`
      + `<div class="cp-mod">${cpWin(k.hdg.label, k.hdg.value)}${cpKnob(k.hdg)}</div>`
      + `<div class="cp-mod">${cpWin(k.alt.label, k.alt.value)}<div class="cp-row">${cpKnob(k.alt)}${cpBtn(k.altIntv)}</div><div class="cp-row">${cpBtn(k.althld)}${cpBtn(k.vsbtn)}</div></div>`
      + `<div class="cp-mod">${cpWin(k.vs.label, k.vs.value)}${cpWheel(k.vs)}</div>`
      + `<div class="cp-mod"><div class="cp-label-top">A/P ENGAGE</div><div class="cp-grid2 eng">${cpBtn(k.cmdA)}${cpBtn(k.cmdB)}${cpBtn(k.cwsA)}${cpBtn(k.cwsB)}</div>${cpBtn(k.disengage)}</div>`
      + `<div class="cp-mod"><div class="cp-stack">${cpWin(k.courseR.label, k.courseR.value)}${cpBtn(k.fdR, 'sw')}</div></div>`
      + `</div>`;
  }

  function fcuHtml(k, style) {
    const a350 = style === 'fcu350';
    const lcd = [['SPD', k.spd], ['HDG', k.hdg], ['ALT', k.alt], ['V/S', k.vs]]
      .map(([label, c]) => cpWin(label, c.managed ? `${c.value}•` : c.value, c.managed ? 'managed' : '')).join('');
    return `<div class="cockpit ${a350 ? 'fcu350' : 'fcu'}">`
      + `<div class="fcu-lcd">${lcd}</div>`
      + `<div class="fcu-controls">`
      + `<div class="cp-mod"><div class="cp-label-top">SPD MACH</div>${cpBtn(k.spdMach)}${cpKnob(k.spd, 'big')}</div>`
      + `<div class="cp-mod"><div class="cp-label-top">HDG TRK</div>${cpBtn(k.hdgTrk)}${cpKnob(k.hdg, 'big')}</div>`
      + `<div class="cp-mod"><div class="cp-grid2">${cpBtn(k.ap1)}${cpBtn(k.ap2)}</div>${cpBtn(k.athr)}${cpBtn(k.loc)}</div>`
      + `<div class="cp-mod"><div class="cp-label-top">ALT</div>${cpBtn(k.metric)}${cpKnob(k.alt, 'big')}</div>`
      + `<div class="cp-mod"><div class="cp-label-top">V/S FPA</div>${cpBtn(k.vsFpa)}${cpKnob(k.vs, 'big')}</div>`
      + `<div class="cp-mod">${cpBtn(k.exped)}${cpBtn(k.appr)}</div>`
      + `</div></div>`;
  }

  function fcpHtml(k) {
    return `<div class="cockpit fcp">`
      + `<div class="cp-mod"><div class="cp-col">${cpBtn(k.ap)}${cpBtn(k.yd)}${cpBtn(k.at)}</div></div>`
      + `<div class="cp-mod">${cpWin(k.ias.label, k.ias.value)}<div class="cp-row">${cpKnob(k.ias)}${cpBtn(k.spd)}</div></div>`
      + `<div class="cp-mod">${cpWin(k.hdg.label, k.hdg.value)}<div class="cp-row">${cpKnob(k.hdg)}<div class="cp-col">${cpBtn(k.hdgBtn)}${cpBtn(k.nav)}${cpBtn(k.appr)}</div></div></div>`
      + `<div class="cp-mod">${cpWin(k.alt.label, k.alt.value)}<div class="cp-row">${cpKnob(k.alt)}<div class="cp-col">${cpBtn(k.vnav)}${cpBtn(k.flc)}${cpBtn(k.altBtn)}</div></div></div>`
      + `<div class="cp-mod">${cpWin(k.vs.label, k.vs.value)}<div class="cp-row">${cpWheel(k.vs)}${cpBtn(k.vsBtn)}</div></div>`
      + `<div class="cp-mod">${cpBtn(k.disc)}</div>`
      + `</div>`;
  }

  function gpHtml(k) {
    return `<div class="cockpit gp">`
      + `<div class="cp-mod"><div class="cp-row">${cpBtn(k.hsi)}${cpBtn(k.wx)}${cpBtn(k.fms)}</div><div class="cp-row">${cpBtn(k.brg1)}${cpBtn(k.prev)}${cpBtn(k.vl)}</div><div class="cp-row">${cpBtn(k.brg2)}${cpBtn(k.fpr)}</div></div>`
      + `<div class="cp-mod">${cpBtn(k.fd, 'sw')}${cpWin(k.crs.label, k.crs.value)}${cpKnob(k.crs)}</div>`
      + `<div class="cp-mod"><div class="cp-row">${cpBtn(k.nav)}${cpBtn(k.hdgBtn)}</div><div class="cp-row">${cpBtn(k.appr)}${cpBtn(k.bank)}</div></div>`
      + `<div class="cp-mod">${cpWin(k.hdg.label, k.hdg.value)}${cpKnob(k.hdg)}</div>`
      + `<div class="cp-mod"><div class="cp-col">${cpBtn(k.ap)}${cpBtn(k.yd)}${cpBtn(k.src)}</div></div>`
      + `<div class="cp-mod">${cpWin(k.ias.label, k.ias.value)}${cpKnob(k.ias)}</div>`
      + `<div class="cp-mod"><div class="cp-row">${cpBtn(k.at)}${cpBtn(k.flc)}${cpBtn(k.altBtn)}</div><div class="cp-row">${cpBtn(k.vnav)}${cpBtn(k.vsBtn)}${cpBtn(k.spd)}</div></div>`
      + `<div class="cp-mod">${cpWin(k.alt.label, k.alt.value)}${cpKnob(k.alt)}</div>`
      + `<div class="cp-mod">${cpWin(k.vs.label, k.vs.value)}${cpWheel(k.vs)}</div>`
      + `<div class="cp-mod">${cpBtn(k.disc)}</div>`
      + `</div>`;
  }

  function panelItemHtml(item, skin) {
    if (item.type === 'cockpit' && item.style === 'gp') return gpHtml(item.controls);
    if (item.type === 'cockpit' && item.style === 'fcp') return fcpHtml(item.controls);
    if (item.type === 'cockpit') return item.style === 'mcp' ? mcpHtml(item.controls) : fcuHtml(item.controls, item.style);
    if (item.type === 'group') return `<div class="group">${item.items.map((i) => panelItemHtml(i, skin)).join('')}</div>`;
    if (item.type === 'button') {
      return `<button class="ap-btn ${item.lit ? 'lit' : ''} ${escapeHtml(item.cls || '')}" data-id="${item.id}" data-action="click">${escapeHtml(item.label)}</button>`;
    }
    const value = item.managed && (skin === 'airbus' || skin === 'a350') ? '---•' : item.value;
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
    const indexed = vm.fkeys.map((k, i) => ({ k, i }));
    renderScreen(vm.screen, indexed.filter(({ k }) => k.group === 'tab'), indexed);
    renderKeys(vm);
    $('ap-panel').innerHTML = vm.panel.map((i) => panelItemHtml(i, vm.skin)).join('');
    $('fma').innerHTML = vm.fma.cols.map((text, i) => `<div class="fma-col ${i === 3 ? 'ap' : ''}">${escapeHtml(text || '')}</div>`).join('')
      + (vm.fma.warn ? `<div class="fma-warn">${escapeHtml(vm.fma.warn)}</div>` : '');
    renderStatus(vm.status);
  }

  root.FmsView = { mount, render, renderStatus };
})(typeof self !== 'undefined' ? self : this);
